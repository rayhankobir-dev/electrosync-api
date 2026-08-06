import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { NescoPortalClient } from './nesco-portal.client';

/**
 * The portal answers 403 to every source IP outside Bangladesh, so a backend
 * hosted anywhere else can only reach it through a Bangladeshi egress. These
 * tests pin the wiring that makes that possible — and, just as importantly,
 * that a deployment which does not need it keeps connecting directly.
 */
describe('NescoPortalClient proxy wiring', () => {
  let create: jest.SpyInstance;

  function clientWithProxy(proxyUrl: string | undefined): NescoPortalClient {
    const config = {
      get: jest.fn().mockReturnValue(proxyUrl),
    } as unknown as ConfigService;

    return new NescoPortalClient(config);
  }

  /** The config object handed to `axios.create()` by the constructor. */
  function axiosConfig(): Record<string, unknown> {
    expect(create).toHaveBeenCalledTimes(1);
    return create.mock.calls[0][0] as Record<string, unknown>;
  }

  beforeEach(() => {
    create = jest.spyOn(axios, 'create');
    // The constructor announces its egress on boot; keep a green run quiet.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('connects directly when no proxy is configured', () => {
    clientWithProxy(undefined);

    const config = axiosConfig();
    expect(config.httpsAgent).toBeUndefined();
    expect(config.httpAgent).toBeUndefined();
  });

  it('routes through a SOCKS agent for socks5:// proxies', () => {
    clientWithProxy('socks5://127.0.0.1:1080');

    // An `ssh -D` tunnel to a Bangladeshi box is the cheapest working egress,
    // and it speaks SOCKS5 — so this scheme has to be supported, not just HTTP.
    expect(axiosConfig().httpsAgent).toBeInstanceOf(SocksProxyAgent);
  });

  it('routes through an HTTPS proxy agent for http:// proxies', () => {
    clientWithProxy('http://user:pass@bd-proxy.example:8080');

    // `HttpsProxyAgent`, not `HttpProxyAgent`: the agent is named for the
    // protocol of the *destination* (https://customer.nesco.gov.bd), which it
    // reaches by CONNECT-tunnelling through a plain-HTTP proxy.
    expect(axiosConfig().httpsAgent).toBeInstanceOf(HttpsProxyAgent);
  });

  it('disables axios proxy autodetection whenever an agent is used', () => {
    clientWithProxy('socks5://127.0.0.1:1080');

    // Left at its default, axios would *also* apply HTTP_PROXY/HTTPS_PROXY from
    // the environment on top of our agent. On a host that sets those for an
    // unrelated reason that silently double-proxies every portal request.
    expect(axiosConfig().proxy).toBe(false);
  });

  it('refuses to start on an unsupported proxy scheme', () => {
    // Failing here means a typo surfaces in the boot log. Deferring it to the
    // first request would surface it as the same opaque 502 this replaces.
    expect(() => clientWithProxy('ftp://bd-proxy.example:8080')).toThrow(
      /NESCO_PROXY_URL/,
    );
  });

  it('keeps the timeout, user agent and status policy alongside the proxy', () => {
    clientWithProxy('socks5://127.0.0.1:1080');

    const config = axiosConfig();
    expect(config.timeout).toBe(15_000);
    expect(config.responseType).toBe('text');
    expect((config.validateStatus as (status: number) => boolean)(403)).toBe(
      false,
    );
  });
});
