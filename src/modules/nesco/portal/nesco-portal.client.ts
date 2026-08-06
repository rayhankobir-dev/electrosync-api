import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
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
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    const proxyUrl = this.config.get<string>('NESCO_PROXY_URL');
    const agent = proxyUrl ? this.createProxyAgent(proxyUrl) : undefined;

    this.http = axios.create({
      timeout: NESCO_REQUEST_TIMEOUT_MS,
      responseType: 'text',
      headers: { 'User-Agent': NESCO_USER_AGENT },
      // The portal returns HTML for every outcome, so let non-2xx surface as a
      // distinguishable transport failure rather than as unparseable markup.
      validateStatus: (status) => status >= 200 && status < 300,
      // Attaching the agent to the instance rather than to individual calls is
      // what guarantees BOTH legs of the exchange take the same route. The
      // session cookie and CSRF token minted by the GET are bound to the IP the
      // portal saw; sending the POST from a different one loses the session.
      ...(agent
        ? { httpAgent: agent, httpsAgent: agent, proxy: false as const }
        : {}),
    });

    if (proxyUrl) {
      this.logger.log(
        `Portal requests routed via ${redactCredentials(proxyUrl)}`,
      );
    }
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
