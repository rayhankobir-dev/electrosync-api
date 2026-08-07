import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

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

/** One way out to the portal: an axios instance plus how to name it in a log. */
interface PortalRoute {
  /** Credential-free rendering of the proxy, or absent for a direct route. */
  readonly description?: string;
  readonly http: AxiosInstance;
}

/**
 * Splits `NESCO_PROXY_URL` into individual proxies.
 *
 * A comma-separated list rather than a single value because the free
 * Bangladeshi proxies this is most likely to be pointed at are individually
 * unreliable — each is up roughly half the time — but they fail independently.
 * Trying several in turn is what makes them usable at all. A single value is
 * still valid and behaves exactly as before.
 */
function parseProxyList(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Whether a failure justifies re-running the exchange on the next route.
 *
 * The distinction that matters is "this hop is broken" versus "the portal
 * answered". A dead proxy, a timeout, or the 403 the portal serves to foreign
 * addresses all mean the egress is wrong and another might work. A page whose
 * markup we cannot read is included because a failing proxy commonly answers
 * with its own error page rather than the portal's HTML — but not a customer
 * lookup that came back empty, which is a real answer and identical on every
 * route.
 */
function isRetryableAcrossRoutes(error: unknown): boolean {
  if (!(error instanceof NescoPortalError)) return false;

  return (
    error.reason === 'UPSTREAM_UNREACHABLE' ||
    error.reason === 'UPSTREAM_TIMEOUT' ||
    error.reason === 'UPSTREAM_ERROR' ||
    error.reason === 'LAYOUT_CHANGED'
  );
}

/**
 * Strips any userinfo from a proxy URL before it reaches a log line.
 *
 * A proxy URL routinely carries `user:password@`, and both the boot message and
 * the constructor's error paths would otherwise write those credentials to a
 * log aggregator in plaintext. Falls back to the scheme alone when the value is
 * too malformed to parse — that is exactly the case being reported, so it must
 * not itself throw.
 */
function redactCredentials(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.toString();
  } catch {
    return `${proxyUrl.split('://', 1)[0]}://<unparseable>`;
  }
}

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
  /** Egress options, tried in order. Always at least one entry. */
  private readonly routes: readonly PortalRoute[];

  /**
   * Where the next lookup starts. Sticky on the last route that answered.
   *
   * Without this, a dead entry ahead of a working one is re-dialled on every
   * lookup and each retry costs a full connect timeout first — measured at
   * ~15s per dead entry against real proxies, on every single request. Sticking
   * to what last worked keeps the steady state at one attempt, and the list
   * still gets walked the moment that route stops answering.
   */
  private preferredRoute = 0;

  constructor(private readonly config: ConfigService) {
    const proxyUrls = parseProxyList(
      this.config.get<string>('NESCO_PROXY_URL'),
    );

    this.routes =
      proxyUrls.length > 0
        ? proxyUrls.map((proxyUrl) => ({
            description: redactCredentials(proxyUrl),
            http: this.createHttp(this.createProxyAgent(proxyUrl)),
          }))
        : [{ http: this.createHttp(undefined) }];

    if (proxyUrls.length > 0) {
      this.logger.log(
        `Portal requests routed via ${this.routes.length} proxy route(s): ${this.routes
          .map((route) => route.description)
          .join(', ')}`,
      );
    }
  }

  private createHttp(agent: Agent | undefined): AxiosInstance {
    return axios.create({
      timeout: NESCO_REQUEST_TIMEOUT_MS,
      responseType: 'text',
      headers: { 'User-Agent': NESCO_USER_AGENT },
      // The portal returns HTML for every outcome, so let non-2xx surface as a
      // distinguishable transport failure rather than as unparseable markup.
      validateStatus: (status) => status >= 200 && status < 300,
      // One axios instance per route, with the agent bound to the instance, is
      // what keeps BOTH legs of an exchange on the same egress. The session
      // cookie and CSRF token minted by the GET are bound to the address the
      // portal saw; sending the POST from another one loses the session.
      ...(agent
        ? { httpAgent: agent, httpsAgent: agent, proxy: false as const }
        : {}),
    });
  }

  /**
   * Builds the outbound agent for `NESCO_PROXY_URL`.
   *
   * The portal answers HTTP 403 to every source IP outside Bangladesh — the GET
   * that opens the session included, so nothing works from a foreign host.
   * Confirmed against 18 vantage points in 14 countries: all 403, while a
   * Bangladeshi IP gets 200 with any User-Agent, including none at all. A
   * backend hosted abroad therefore needs Bangladeshi egress, and this is the
   * seam where that is attached.
   *
   * Throwing on a bad value is deliberate: Nest instantiates providers at boot,
   * so a typo here stops the app with a legible message instead of turning into
   * the same opaque 502 this exists to prevent.
   */
  private createProxyAgent(proxyUrl: string): Agent {
    let protocol: string;

    try {
      protocol = new URL(proxyUrl).protocol;
    } catch {
      throw new Error(
        `NESCO_PROXY_URL is not a valid URL: ${redactCredentials(proxyUrl)}`,
      );
    }

    switch (protocol) {
      // `ssh -D 1080 user@bd-host` is the cheapest working egress and speaks
      // SOCKS5, so this is the scheme most deployments will actually use.
      case 'socks:':
      case 'socks4:':
      case 'socks4a:':
      case 'socks5:':
      case 'socks5h:':
        return new SocksProxyAgent(proxyUrl);

      // `HttpsProxyAgent`, not `HttpProxyAgent`: the agent is named for the
      // protocol of the destination (https://customer.nesco.gov.bd), which it
      // reaches by CONNECT-tunnelling through the proxy. `HttpProxyAgent` would
      // try to send the request in absolute-URI form and never negotiate TLS.
      case 'http:':
      case 'https:':
        return new HttpsProxyAgent(proxyUrl);

      default:
        throw new Error(
          `NESCO_PROXY_URL has unsupported scheme "${protocol}" — expected one of http, https, socks4, socks5.`,
        );
    }
  }

  /**
   * Runs the GET-then-POST exchange and returns the report page's HTML,
   * falling forward through the configured egress routes.
   *
   * Failover is per *exchange*, never per request. Retrying just the POST on
   * another route would present a CSRF token minted for a session the second
   * route's address never opened, so a whole exchange is the smallest unit that
   * can be retried correctly.
   *
   * Only transport-shaped failures move to the next route. A portal answer that
   * merely has no data in it is a real answer and must not burn the whole list.
   */
  async fetchReport(
    customerNumber: string,
    submitType: SubmitType,
  ): Promise<string> {
    let lastError: unknown;
    const total = this.routes.length;

    for (let attempt = 0; attempt < total; attempt += 1) {
      const index = (this.preferredRoute + attempt) % total;
      const route = this.routes[index];

      try {
        const html = await this.fetchVia(route, customerNumber, submitType);
        this.preferredRoute = index;
        return html;
      } catch (error) {
        lastError = error;

        if (attempt === total - 1 || !isRetryableAcrossRoutes(error)) {
          throw error;
        }

        this.logger.warn(
          `Egress ${route.description ?? 'direct'} failed (${
            (error as Error).message
          }); trying next route`,
        );
      }
    }

    throw lastError;
  }

  /** One complete exchange over a single egress route. */
  private async fetchVia(
    route: PortalRoute,
    customerNumber: string,
    submitType: SubmitType,
  ): Promise<string> {
    const { csrfToken, cookieHeader } = await this.openSession(route);

    const body = new URLSearchParams({
      _token: csrfToken,
      cust_no: customerNumber,
      submit: submitType,
    });

    const html = await this.request(route, 'report POST', () =>
      route.http.post<string>(NESCO_BASE_URL, body.toString(), {
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
  private async openSession(route: PortalRoute): Promise<{
    csrfToken: string;
    cookieHeader: string;
  }> {
    const response = await this.requestRaw(route, 'session GET', () =>
      route.http.get<string>(NESCO_BASE_URL),
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
    route: PortalRoute,
    stage: ExchangeStage,
    send: () => Promise<{ data: unknown }>,
  ): Promise<string> {
    const response = await this.requestRaw(route, stage, send);
    return this.asHtml(response.data);
  }

  /**
   * Wraps an axios call so every transport failure leaves this class as a typed
   * `NescoPortalError`. Callers upstream never need to know axios exists.
   */
  private async requestRaw<T extends { data: unknown }>(
    route: PortalRoute,
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
            `The NESCO portal responded with HTTP ${error.response.status} to the ${stage}`,
            error,
          );
        }

        throw new NescoPortalError(
          'UPSTREAM_UNREACHABLE',
          `The NESCO portal could not be reached on the ${stage} (${this.describeTransportFailure(error, route)})`,
          error,
        );
      }

      throw error;
    }
  }

  /**
   * Renders a connection failure into something an operator can act on.
   *
   * `error.code` alone is not enough. Node sets it for its own socket errors
   * (ECONNREFUSED, ENOTFOUND), but a SOCKS handshake rejected by the proxy
   * arrives as a plain `Error` with a descriptive message and no code at all —
   * so keying on the code collapsed every proxy misconfiguration into the
   * single useless string "unknown error".
   *
   * Naming the proxy matters just as much. Once traffic is tunnelled there are
   * two hops that can fail and the reason reads `UPSTREAM_UNREACHABLE` for
   * both, even though "your proxy refused the connection" and "the portal is
   * down" call for opposite responses.
   */
  private describeTransportFailure(
    error: AxiosError,
    route: PortalRoute,
  ): string {
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
    // where axios has wrapped the agent's error in a generic message. Bounded
    // because `cause` is attacker-agnostic but not guaranteed acyclic.
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
      add(current.message);
      current = (current as { cause?: unknown }).cause;
    }

    if (parts.length === 0) add('unknown error');
    if (route.description) add(`via proxy ${route.description}`);

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
