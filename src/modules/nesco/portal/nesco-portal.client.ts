import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

import {
  NESCO_BASE_URL,
  NESCO_REQUEST_TIMEOUT_MS,
  NESCO_USER_AGENT,
  SELECTOR,
  SubmitType,
} from './nesco.constants';
import { NescoPortalError } from './nesco.errors';

/**
 * Which leg of the two-step exchange a failure came from.
 *
 * The legs are not interchangeable diagnostically. The `session GET` carries no
 * cookies and no CSRF token, so a refusal there can only be about the
 * connection or its source address. The `report POST` carries both, so a
 * refusal there — 419 in Laravel's vocabulary — implicates the session. Without
 * the label the two are indistinguishable in a log and the wrong one gets
 * investigated.
 */
type ExchangeStage = 'session GET' | 'report POST';

/**
 * Owns the conversation with the NESCO portal and nothing else: it returns raw
 * HTML and never interprets it.
 *
 * The portal has no API. Each lookup is a two-step exchange — GET the panel to
 * mint a CSRF token and a session cookie, then POST the customer number back
 * with both. Because the token is bound to that session, the two requests
 * cannot be cached or split apart.
 *
 * ## This class deliberately has no egress configuration
 *
 * customer.nesco.gov.bd refuses requests by **source IP**: every address
 * outside Bangladesh gets a bare HTTP 403 with a zero-length body, the opening
 * GET included, so no session is ever established. That was confirmed by
 * elimination rather than assumed — browser headers, a Chrome TLS fingerprint
 * (JA3), a Mumbai-region deployment and the site root were each tried and each
 * returned a byte-identical 403, while the same code from a Bangladeshi ISP
 * returns 200 with any User-Agent or none at all.
 *
 * Two consequences follow, and they are why this file looks the way it does:
 *
 * 1. No header, fingerprint or client library can fix it. The rejection happens
 *    before the request is read.
 * 2. The only thing that works is changing **where the process runs**. The
 *    backend must originate its traffic from a Bangladeshi connection, which is
 *    a deployment concern rather than a code one — see `README.md`.
 *
 * Note that the customer number is a per-call argument rather than constructor
 * state (as it was in the original script). That is what allows this to be a
 * singleton provider instead of an object rebuilt on every request.
 */
@Injectable()
export class NescoPortalClient {
  private readonly logger = new Logger(NescoPortalClient.name);

  /**
   * One instance for the whole app, and one for both legs of every exchange.
   *
   * Sharing it is not merely an optimisation: the CSRF token and session cookie
   * minted by the GET are bound to the address the portal saw, so the POST has
   * to leave from the same place.
   */
  private readonly http: AxiosInstance = axios.create({
    timeout: NESCO_REQUEST_TIMEOUT_MS,
    responseType: 'text',
    headers: { 'User-Agent': NESCO_USER_AGENT },
    // The portal returns HTML for every outcome, so let non-2xx surface as a
    // distinguishable transport failure rather than as unparseable markup.
    validateStatus: (status) => status >= 200 && status < 300,
  });

  /** Runs the GET-then-POST exchange and returns the report page's HTML. */
  async fetchReport(
    customerNumber: string,
    submitType: SubmitType,
  ): Promise<string> {
    const { csrfToken, cookieHeader } = await this.openSession();

    const body = new URLSearchParams({
      _token: csrfToken,
      cust_no: customerNumber,
      submit: submitType,
    });

    const html = await this.request('report POST', () =>
      this.http.post<string>(NESCO_BASE_URL, body.toString(), {
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }),
    );

    this.logger.debug(
      `Fetched "${submitType}" report for customer ${customerNumber} (${html.length} bytes)`,
    );

    return html;
  }

  /** GETs the panel to obtain a CSRF token bound to a fresh session cookie. */
  private async openSession(): Promise<{
    csrfToken: string;
    cookieHeader: string;
  }> {
    const response = await this.requestRaw('session GET', () =>
      this.http.get<string>(NESCO_BASE_URL),
    );

    const $ = cheerio.load(this.asHtml(response.data));
    const csrfToken = $(SELECTOR.CSRF_META).attr('content');

    if (!csrfToken) {
      throw new NescoPortalError(
        'LAYOUT_CHANGED',
        'The portal page no longer exposes a csrf-token meta tag',
      );
    }

    return {
      csrfToken,
      cookieHeader: this.toCookieHeader(response.headers['set-cookie']),
    };
  }

  /**
   * Builds a `Cookie` request header from `Set-Cookie` response headers.
   *
   * Only the `name=value` pair belongs in a request; forwarding the whole
   * `Set-Cookie` string (attributes like `Path` and `HttpOnly` included) sends
   * the server a malformed header that it may quietly ignore, costing us the
   * session the CSRF token is bound to.
   */
  private toCookieHeader(setCookie: string[] | undefined): string {
    if (!setCookie || setCookie.length === 0) {
      throw new NescoPortalError(
        'LAYOUT_CHANGED',
        'The portal did not issue a session cookie',
      );
    }

    return setCookie
      .map((cookie) => cookie.split(';', 1)[0].trim())
      .filter((pair) => pair.length > 0)
      .join('; ');
  }

  private async request(
    stage: ExchangeStage,
    send: () => Promise<{ data: unknown }>,
  ): Promise<string> {
    const response = await this.requestRaw(stage, send);
    return this.asHtml(response.data);
  }

  /**
   * Wraps an axios call so every transport failure leaves this class as a typed
   * `NescoPortalError`. Callers upstream never need to know axios exists.
   */
  private async requestRaw<T extends { data: unknown }>(
    stage: ExchangeStage,
    send: () => Promise<T>,
  ): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw new NescoPortalError(
            'UPSTREAM_TIMEOUT',
            `The NESCO portal did not respond within ${NESCO_REQUEST_TIMEOUT_MS}ms on the ${stage}`,
            error,
          );
        }

        if (error.response) {
          throw new NescoPortalError(
            'UPSTREAM_ERROR',
            `The NESCO portal responded with HTTP ${error.response.status} to the ${stage}${this.hintForStatus(error.response.status)}`,
            error,
          );
        }

        throw new NescoPortalError(
          'UPSTREAM_UNREACHABLE',
          `The NESCO portal could not be reached on the ${stage} (${this.describeTransportFailure(error)})`,
          error,
        );
      }

      throw error;
    }
  }

  /**
   * Appends the one diagnosis a status code cannot carry on its own.
   *
   * A 403 here has exactly one known cause, and it is not the one an operator
   * reaches for first. Without this sentence the log line invites a hunt through
   * headers and user agents — the search that has already been run, and that
   * ends nowhere. Naming it inline is what turns a recurring investigation into
   * a one-line answer.
   */
  private hintForStatus(status: number): string {
    if (status !== 403) return '';

    return (
      ' — the portal serves 403 to every source IP outside Bangladesh, so this' +
      ' host is almost certainly running abroad. See README.md: no header,' +
      ' fingerprint or client setting fixes this, only where the process runs.'
    );
  }

  /**
   * Renders a connection failure into something an operator can act on.
   *
   * `error.code` alone is not enough. Node sets it for its own socket errors
   * (ECONNREFUSED, ENOTFOUND), but errors raised by an outbound agent or a TLS
   * layer commonly arrive as a plain `Error` with a descriptive message and no
   * code at all — so keying on the code collapsed a whole family of
   * misconfigurations into the single useless string "unknown error".
   */
  private describeTransportFailure(error: AxiosError): string {
    const seen = new Set<string>();
    const parts: string[] = [];

    const add = (value: string | undefined): void => {
      const trimmed = value?.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        parts.push(trimmed);
      }
    };

    add(error.code);

    // Walk the cause chain: the actionable detail is often one level down,
    // where axios has wrapped a lower-level error in a generic message. Bounded
    // because `cause` is attacker-agnostic but not guaranteed acyclic.
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
      add(current.message);
      current = (current as { cause?: unknown }).cause;
    }

    if (parts.length === 0) add('unknown error');

    return parts.join('; ');
  }

  private asHtml(data: unknown): string {
    if (typeof data !== 'string') {
      throw new NescoPortalError(
        'LAYOUT_CHANGED',
        `Expected HTML from the portal but received ${typeof data}`,
      );
    }
    return data;
  }
}
