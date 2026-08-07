import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { NescoPortalClient } from './nesco-portal.client';
import { SUBMIT_TYPE } from './nesco.constants';

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

/**
 * A proxy hop is a second thing that can fail, and it fails in ways the portal
 * never does. These tests pin that the diagnosis survives the trip upward —
 * an operator reading the log has to be able to tell "your proxy is refusing
 * connections" from "the portal is down" without attaching a debugger.
 */
describe('NescoPortalClient transport diagnostics', () => {
  const PROXY = 'socks5://user:hunter2@bd-host.example:1080';

  /**
   * Builds a client whose every request rejects with `error`.
   *
   * `null` means "no proxy configured" rather than `undefined`, because a
   * default parameter cannot distinguish an explicitly passed `undefined` from
   * an omitted argument — which silently gave the unproxied case a proxy.
   */
  function clientRejectingWith(
    error: unknown,
    proxyUrl: string | null = PROXY,
  ): NescoPortalClient {
    jest.spyOn(axios, 'create').mockReturnValue({
      get: jest.fn().mockRejectedValue(error),
      post: jest.fn().mockRejectedValue(error),
    } as never);

    return new NescoPortalClient({
      get: jest.fn().mockReturnValue(proxyUrl ?? undefined),
    } as unknown as ConfigService);
  }

  async function failureMessage(client: NescoPortalClient): Promise<string> {
    try {
      await client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected fetchReport to reject');
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the underlying message when the failure carries no error code', async () => {
    // SOCKS failures arrive with no `code` at all. Reporting only the code —
    // as this did — reduced every one of them to "unknown error", which is
    // exactly the log line that cost a deploy cycle to interpret.
    const message = await failureMessage(
      clientRejectingWith(
        new axios.AxiosError('Socks5 proxy rejected connection - Failure'),
      ),
    );

    expect(message).toContain('Socks5 proxy rejected connection');
    expect(message).not.toContain('unknown error');
  });

  it('names the proxy hop so the failing component is unambiguous', async () => {
    const message = await failureMessage(
      clientRejectingWith(new axios.AxiosError('connect ECONNREFUSED')),
    );

    expect(message).toContain('bd-host.example:1080');
  });

  it('never leaks proxy credentials into the failure message', async () => {
    const message = await failureMessage(
      clientRejectingWith(new axios.AxiosError('connect ECONNREFUSED')),
    );

    expect(message).not.toContain('hunter2');
  });

  it('unwraps the cause chain beneath the axios error', async () => {
    const outer = new axios.AxiosError('Proxy connection failed');
    outer.cause = new Error('getaddrinfo ENOTFOUND bd-host.example');

    expect(await failureMessage(clientRejectingWith(outer))).toContain(
      'ENOTFOUND bd-host.example',
    );
  });

  it('still reports the code when one is present', async () => {
    const message = await failureMessage(
      clientRejectingWith(new axios.AxiosError('socket hang up', 'ECONNRESET')),
    );

    expect(message).toContain('ECONNRESET');
  });

  it('says nothing about a proxy when none is configured', async () => {
    const message = await failureMessage(
      clientRejectingWith(
        new axios.AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'),
        null,
      ),
    );

    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toContain('proxy');
  });
});

/**
 * Free Bangladeshi proxies are individually unreliable — each is up roughly
 * half the time — but they fail independently, so trying several in turn is
 * what makes the set usable without paying for egress.
 */
describe('NescoPortalClient egress failover', () => {
  const PAGE = '<meta name="csrf-token" content="tok"><html>report</html>';

  /** An axios double that fails or succeeds on demand, recording its calls. */
  function route(behaviour: 'fail' | 'ok') {
    const response = {
      data: PAGE,
      headers: { 'set-cookie': ['session=abc; Path=/'] },
    };
    const reject = () =>
      Promise.reject(
        new axios.AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'),
      );

    return {
      get: jest.fn(
        behaviour === 'ok' ? () => Promise.resolve(response) : reject,
      ),
      post: jest.fn(
        behaviour === 'ok' ? () => Promise.resolve(response) : reject,
      ),
    };
  }

  function clientOver(routes: ReturnType<typeof route>[], proxies: string) {
    const create = jest.spyOn(axios, 'create');
    routes.forEach((r) => create.mockReturnValueOnce(r as never));

    return new NescoPortalClient({
      get: jest.fn().mockReturnValue(proxies),
    } as unknown as ConfigService);
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('falls back to the next proxy when the first is unreachable', async () => {
    const [dead, alive] = [route('fail'), route('ok')];
    const client = clientOver(
      [dead, alive],
      'socks5://dead.example:1080,socks5://alive.example:1080',
    );

    await expect(
      client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY),
    ).resolves.toContain('report');
    expect(dead.get).toHaveBeenCalled();
    expect(alive.post).toHaveBeenCalled();
  });

  it('keeps both legs of one exchange on the same proxy', async () => {
    const [dead, alive] = [route('fail'), route('ok')];
    const client = clientOver(
      [dead, alive],
      'socks5://dead.example:1080,socks5://alive.example:1080',
    );

    await client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY);

    // The CSRF token and session cookie are bound to the address the portal
    // saw on the GET. Retrying only the POST through a different egress would
    // present a token minted for a session that IP never opened.
    expect(alive.get).toHaveBeenCalledTimes(1);
    expect(alive.post).toHaveBeenCalledTimes(1);
    expect(dead.post).not.toHaveBeenCalled();
  });

  it('reports the final failure when every proxy is down', async () => {
    const client = clientOver(
      [route('fail'), route('fail')],
      'socks5://a.example:1080,socks5://b.example:1080',
    );

    await expect(
      client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY),
    ).rejects.toThrow(/could not be reached/);
  });

  it('tolerates whitespace and blank entries in the list', () => {
    const routes = [route('ok'), route('ok')];
    clientOver(routes, ' socks5://a.example:1080 , , socks5://b.example:1080 ');

    expect(axios.create).toHaveBeenCalledTimes(2);
  });

  it('makes exactly one attempt when a single proxy is configured', async () => {
    const only = route('fail');
    const client = clientOver([only], 'socks5://only.example:1080');

    await expect(
      client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY),
    ).rejects.toThrow();
    expect(only.get).toHaveBeenCalledTimes(1);
  });
});

describe('NescoPortalClient route stickiness', () => {
  const PAGE = '<meta name="csrf-token" content="tok"><html>report</html>';

  function stubRoute(behaviour: 'fail' | 'ok') {
    const response = {
      data: PAGE,
      headers: { 'set-cookie': ['session=abc; Path=/'] },
    };
    const send = () =>
      behaviour === 'ok'
        ? Promise.resolve(response)
        : Promise.reject(
            new axios.AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'),
          );

    return { get: jest.fn(send), post: jest.fn(send) };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('starts subsequent lookups at the route that last worked', async () => {
    const [dead, alive] = [stubRoute('fail'), stubRoute('ok')];
    const create = jest.spyOn(axios, 'create');
    [dead, alive].forEach((r) => create.mockReturnValueOnce(r as never));

    const client = new NescoPortalClient({
      get: jest
        .fn()
        .mockReturnValue(
          'socks5://dead.example:1080,socks5://alive.example:1080',
        ),
    } as unknown as ConfigService);

    await client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY);
    expect(dead.get).toHaveBeenCalledTimes(1);

    await client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY);

    // Without stickiness the dead route is retried on every lookup, and each
    // retry costs a full connect timeout before failover — measured at ~15s
    // per dead entry against real proxies, on every single request.
    expect(dead.get).toHaveBeenCalledTimes(1);
    expect(alive.get).toHaveBeenCalledTimes(2);
  });
});

/**
 * The exchange has two legs and they fail for different reasons. A refusal on
 * the opening GET carries no cookies and no token, so it can only be about the
 * connection itself; a refusal on the POST, which does carry both, implicates
 * the session. Naming the leg is what makes that distinction readable from a
 * log line instead of inferred from a status code.
 */
describe('NescoPortalClient failure attribution', () => {
  const PAGE = '<meta name="csrf-token" content="tok"><html>report</html>';
  const okResponse = {
    data: PAGE,
    headers: { 'set-cookie': ['customer_service_portal_session=abc; Path=/'] },
  };

  function clientWhere(
    get: jest.Mock,
    post: jest.Mock = jest.fn().mockResolvedValue(okResponse),
  ) {
    jest.spyOn(axios, 'create').mockReturnValue({ get, post } as never);
    return new NescoPortalClient({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
  }

  const refusal = () => {
    const error = new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST');
    error.response = { status: 403 } as never;
    return error;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('names the opening GET when the session request is refused', async () => {
    const client = clientWhere(jest.fn().mockRejectedValue(refusal()));

    await expect(
      client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY),
    ).rejects.toThrow(/403.*session GET/);
  });

  it('names the report POST when only the second leg is refused', async () => {
    const client = clientWhere(
      jest.fn().mockResolvedValue(okResponse),
      jest.fn().mockRejectedValue(refusal()),
    );

    await expect(
      client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY),
    ).rejects.toThrow(/403.*report POST/);
  });
});
