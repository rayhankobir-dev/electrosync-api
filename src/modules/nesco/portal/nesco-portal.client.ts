import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
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
 * Owns the conversation with the NESCO portal and nothing else: it returns raw
 * HTML and never interprets it.
 *
 * The portal has no API. Each lookup is a two-step exchange — GET the panel to
 * mint a CSRF token and a session cookie, then POST the customer number back
 * with both. Because the token is bound to that session, the two requests
 * cannot be cached or split apart.
 *
 * Note that the customer number is a per-call argument rather than constructor
 * state (as it was in the original script). That is what allows this to be a
 * singleton provider instead of an object rebuilt on every request.
 */
@Injectable()
export class NescoPortalClient {
  private readonly logger = new Logger(NescoPortalClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: NESCO_REQUEST_TIMEOUT_MS,
      responseType: 'text',
      headers: { 'User-Agent': NESCO_USER_AGENT },
      // The portal returns HTML for every outcome, so let non-2xx surface as a
      // distinguishable transport failure rather than as unparseable markup.
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

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

    const html = await this.request(() =>
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
    const response = await this.requestRaw(() =>
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
    send: () => Promise<{ data: unknown }>,
  ): Promise<string> {
    const response = await this.requestRaw(send);
    return this.asHtml(response.data);
  }

  /**
   * Wraps an axios call so every transport failure leaves this class as a typed
   * `NescoPortalError`. Callers upstream never need to know axios exists.
   */
  private async requestRaw<T extends { data: unknown }>(
    send: () => Promise<T>,
  ): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw new NescoPortalError(
            'UPSTREAM_TIMEOUT',
            `The NESCO portal did not respond within ${NESCO_REQUEST_TIMEOUT_MS}ms`,
            error,
          );
        }

        if (error.response) {
          throw new NescoPortalError(
            'UPSTREAM_ERROR',
            `The NESCO portal responded with HTTP ${error.response.status}`,
            error,
          );
        }

        throw new NescoPortalError(
          'UPSTREAM_UNREACHABLE',
          `The NESCO portal could not be reached (${error.code ?? 'unknown error'})`,
          error,
        );
      }

      throw error;
    }
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
