import axios from 'axios';

import { NescoPortalClient } from './nesco-portal.client';
import { SUBMIT_TYPE } from './nesco.constants';

/**
 * The client talks to the portal directly and has no egress configuration at
 * all — Bangladeshi origin is a property of where the process runs, not of a
 * setting. These tests pin the transport policy that goes with that.
 */
describe('NescoPortalClient transport policy', () => {
  let create: jest.SpyInstance;

  /** The config object handed to `axios.create()` by the constructor. */
  function axiosConfig(): Record<string, unknown> {
    new NescoPortalClient();

    expect(create).toHaveBeenCalledTimes(1);
    return create.mock.calls[0][0] as Record<string, unknown>;
  }

  beforeEach(() => {
    create = jest.spyOn(axios, 'create');
  });

  afterEach(() => jest.restoreAllMocks());

  it('connects directly, with no outbound agent', () => {
    const config = axiosConfig();

    // Egress is deliberately unconfigured: the portal keys on source IP, so
    // the fix is *where the process runs*, not how the client connects.
    expect(config.httpsAgent).toBeUndefined();
    expect(config.httpAgent).toBeUndefined();
  });

  it('treats a non-2xx as a transport failure rather than as markup', () => {
    const config = axiosConfig();

    // The portal answers 200 with HTML for every real outcome, empty results
    // included. Letting a 403 through as a "page" would send it to the parsers,
    // where it surfaces as an unreadable-layout error instead of a refusal.
    expect((config.validateStatus as (status: number) => boolean)(403)).toBe(
      false,
    );
    expect((config.validateStatus as (status: number) => boolean)(200)).toBe(
      true,
    );
  });

  it('bounds the wait and asks for text', () => {
    const config = axiosConfig();

    expect(config.timeout).toBe(15_000);
    expect(config.responseType).toBe('text');
  });
});

/**
 * A failed request is the only evidence an operator gets. These tests pin that
 * the diagnosis survives the trip upward — reading the log has to be enough to
 * tell what broke, without attaching a debugger to a deployed process.
 */
describe('NescoPortalClient transport diagnostics', () => {
  function clientRejectingWith(error: unknown): NescoPortalClient {
    jest.spyOn(axios, 'create').mockReturnValue({
      get: jest.fn().mockRejectedValue(error),
      post: jest.fn().mockRejectedValue(error),
    } as never);

    return new NescoPortalClient();
  }

  async function failureMessage(client: NescoPortalClient): Promise<string> {
    try {
      await client.fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected fetchReport to reject');
  }

  afterEach(() => jest.restoreAllMocks());

  it('keeps the underlying message when the failure carries no error code', async () => {
    // Errors raised by a TLS or agent layer arrive with no `code` at all.
    // Reporting only the code — as this once did — reduced every one of them to
    // "unknown error", the log line that cost a deploy cycle to interpret.
    const message = await failureMessage(
      clientRejectingWith(
        new axios.AxiosError('socket disconnected before TLS'),
      ),
    );

    expect(message).toContain('socket disconnected before TLS');
    expect(message).not.toContain('unknown error');
  });

  it('unwraps the cause chain beneath the axios error', async () => {
    const outer = new axios.AxiosError('Connection failed');
    outer.cause = new Error('getaddrinfo ENOTFOUND customer.nesco.gov.bd');

    expect(await failureMessage(clientRejectingWith(outer))).toContain(
      'ENOTFOUND customer.nesco.gov.bd',
    );
  });

  it('still reports the code when one is present', async () => {
    const message = await failureMessage(
      clientRejectingWith(new axios.AxiosError('socket hang up', 'ECONNRESET')),
    );

    expect(message).toContain('ECONNRESET');
  });

  it('falls back to a placeholder rather than an empty description', async () => {
    const message = await failureMessage(
      clientRejectingWith(new axios.AxiosError('')),
    );

    expect(message).toContain('unknown error');
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
    return new NescoPortalClient();
  }

  const refusalWith = (status: number) => () => {
    const error = new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST');
    error.response = { status } as never;
    return error;
  };

  const refusal = refusalWith(403);

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

  it('explains a 403 as a source-IP refusal, not a header problem', async () => {
    const client = clientWhere(jest.fn().mockRejectedValue(refusal()));

    // This sentence is the whole point of the module's history. Every other
    // hypothesis — user agent, TLS fingerprint, region, path — was tested and
    // refuted, so a 403 here has exactly one cause. Saying so in the error is
    // what stops the same investigation being re-run from scratch.
    const message = await client
      .fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY)
      .catch((error: Error) => error.message);

    expect(message).toContain('outside Bangladesh');
    expect(message).toContain('README');
  });

  it('leaves other statuses unadorned', async () => {
    const client = clientWhere(jest.fn().mockRejectedValue(refusalWith(500)()));

    const message = await client
      .fetchReport('33009605', SUBMIT_TYPE.RECHARGE_HISTORY)
      .catch((error: Error) => error.message);

    expect(message).toContain('HTTP 500');
    expect(message).not.toContain('Bangladesh');
  });
});
