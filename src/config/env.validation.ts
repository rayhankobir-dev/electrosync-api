import { Transform, plainToInstance } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export class EnvironmentVariables {
  @IsString()
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message:
      'DATABASE_URL must be a PostgreSQL connection string, e.g. postgresql://user:pass@host:5432/db',
  })
  DATABASE_URL: string;

  /**
   * Optional in the sense that it may be omitted from `.env` — the default
   * below fills it in. It is *not* optional downstream: `main.ts` reads it with
   * `getOrThrow()`, so the value has to exist by the time validation returns.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /**
   * Comma-separated list of allowed browser origins.
   *
   * Parsed here rather than in `main.ts` because `enableCors` compares the
   * request's `Origin` header against this value with `===` when it is a
   * string. Handing it the raw `"a,b"` env value is not an error — it simply
   * matches nothing, so every cross-origin request is rejected while the
   * configuration reads as if it were set. Splitting to an array is what makes
   * each entry independently matchable.
   */
  @Transform(({ value }): string[] => {
    if (Array.isArray(value)) return value as string[];
    if (typeof value !== 'string') return [];
    return value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  CORS_ORIGINS: string[];

  /**
   * RS256 keypair, PEM-encoded.
   *
   * Asymmetric rather than a shared HS256 secret because clients need to
   * verify tokens. With HS256 the verification key IS the signing key, so
   * shipping it to a browser or mobile bundle lets anyone who extracts it mint
   * a token for any account. Here the private key never leaves the server and
   * the public key is safe to publish.
   *
   * Both hold literal \\n escapes in .env, which the JWT provider converts back
   * to real newlines.
   */
  @IsString()
  @Matches(/BEGIN (RSA )?PRIVATE KEY/, {
    message:
      'JWT_PRIVATE_KEY must be a PEM private key. Generate a pair with: openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:2048',
  })
  JWT_PRIVATE_KEY: string;

  @IsString()
  @Matches(/BEGIN PUBLIC KEY/, {
    message:
      'JWT_PUBLIC_KEY must be a PEM public key matching JWT_PRIVATE_KEY.',
  })
  JWT_PUBLIC_KEY: string;

  /**
   * Token lifetime in days.
   *
   * With no session table there is no revocation, so expiry is the only way a
   * leaked token stops working. Rotating the keypair is the emergency lever,
   * and it signs out every user at once.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  JWT_EXPIRY_DAYS: number = 90;

  /**
   * Firebase service-account credentials for FCM push.
   *
   * Optional as a set: the app boots and serves everything else without them,
   * and only push sending fails — with an explicit error, never silently. That
   * matches how the database is treated, and keeps local development of the
   * NESCO endpoints from requiring Firebase credentials.
   */
  @IsOptional()
  @IsString()
  FIREBASE_PROJECT_ID?: string;

  @IsOptional()
  @IsString()
  FIREBASE_CLIENT_EMAIL?: string;

  @IsOptional()
  @IsString()
  FIREBASE_PRIVATE_KEY?: string;

  /**
   * SMTP credentials for outbound mail — currently only password-reset codes.
   *
   * Optional as a set, on the same terms as `FIREBASE_*`: the app boots without
   * them and every other endpoint works. What differs is the fallback. Push has
   * nowhere to go without Firebase, so it errors; a reset code, by contrast, is
   * perfectly useful written to the log, which is exactly what local
   * development wants. `MailService` logs a startup warning naming the
   * degradation, so an unconfigured *production* deployment is visible in the
   * boot output rather than discovered by a user who never got their code.
   *
   * SMTP_HOST is the switch — the others are only read when it is present.
   */
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 587;

  /**
   * Implicit TLS from the first byte, which is what port 465 expects. Port 587
   * wants this off and upgrades in-band via STARTTLS instead.
   *
   * The explicit `@Transform` is here for the same reason as the one on
   * `ALERTS_ENABLED`: `process.env` values are strings, and implicit conversion
   * turns the string "false" into boolean `true`. Getting this wrong does not
   * fail loudly — it hangs, because a plaintext greeting sent to a port
   * expecting a TLS handshake gets no reply.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return false;
    return value.trim().toLowerCase() === 'true';
  })
  @IsBoolean()
  SMTP_SECURE: boolean = false;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  /**
   * The `From` header. Accepts a bare address or a display form such as
   * `ElectroSync <no-reply@electrosync.app>`. Defaults to SMTP_USER, which is
   * the right guess for the app-password setups this is most likely to run on.
   */
  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  /**
   * Master switch for the scheduled meter balance sweep.
   *
   * Off is the right setting for any environment that shares a database with
   * production: the sweep sends real push notifications to real phones, so two
   * environments running it against the same rows means users get every alert
   * twice (the advisory lock only coordinates instances, not databases).
   *
   * The explicit `@Transform` is load-bearing. `process.env` values are always
   * strings, and the implicit conversion `validateEnv` enables would turn the
   * string "false" into boolean `true` — silently arming the job in exactly
   * the environment that set out to disable it.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return true;
    return value.trim().toLowerCase() !== 'false';
  })
  @IsBoolean()
  ALERTS_ENABLED: boolean = true;

  /**
   * Standard 5-field cron expression, in the server's local timezone.
   * Defaults to every six hours on the hour.
   */
  @IsOptional()
  @IsString()
  @Matches(/^(\S+\s+){4}\S+$/, {
    message:
      'ALERTS_CRON must be a 5-field cron expression, e.g. "0 */6 * * *" for every six hours',
  })
  ALERTS_CRON: string = '0 */6 * * *';

  /**
   * Meters scraped simultaneously. Capped low on purpose — the NESCO portal is
   * a public website being scraped, not an API with a rate-limit budget.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  ALERTS_CONCURRENCY: number = 3;

  /**
   * Spend per hour (BDT) above which a usage sample is discarded as bad data.
   *
   * Raise it if a legitimate industrial connection starts showing suppressed
   * samples; lower it only with evidence, since a tight ceiling silently
   * deletes real consumption and the chart gives no hint that it happened.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  USAGE_MAX_COST_PER_HOUR: number = 500;

  /**
   * Hours past which a usage window is flagged as stale. Its cost is still
   * counted — the flag marks that spreading it across days is an estimate.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  USAGE_MAX_WINDOW_HOURS: number = 48;

  /**
   * Proxy (or comma-separated list of proxies) for NESCO portal requests.
   * Optional.
   *
   * The portal answers HTTP 403 to every source IP outside Bangladesh, so a
   * deployment hosted anywhere else cannot reach it at all — not even the GET
   * that mints the CSRF token. Point this at a proxy with a Bangladeshi address
   * and the portal sees that address instead of the host's.
   *
   * A list is supported because the free Bangladeshi proxies this is most
   * likely to hold are individually unreliable — each up roughly half the time
   * — but fail independently. The client walks the list per exchange until one
   * answers, so several unreliable entries compose into a usable egress. Order
   * them best-first.
   *
   * Leave it empty when the host is already in Bangladesh, including local
   * development: unset means a direct connection, which is what you want.
   *
   * Only NESCO traffic is affected. Deliberately not `HTTPS_PROXY`, which every
   * outbound client in the process would pick up — the database, Firebase and
   * SMTP have no reason to take a detour through Bangladesh.
   */
  @IsOptional()
  @IsString()
  @Matches(
    /^\s*(https?|socks|socks4a?|socks5h?):\/\/[^,\s]+(\s*,\s*(https?|socks|socks4a?|socks5h?):\/\/[^,\s]+)*\s*$/,
    {
      message:
        'NESCO_PROXY_URL must be one or more comma-separated proxy URLs, e.g. socks5://127.0.0.1:1080,http://user:pass@host:8080',
    },
  )
  NESCO_PROXY_URL?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const parsed = plainToInstance(EnvironmentVariables, config, {
    // process.env values are all strings; this turns PORT="3000" into a number
    // so @IsInt() can pass.
    enableImplicitConversion: true,
    // Without this, class-transformer discards the property initialisers above
    // and an omitted PORT arrives as undefined — which validates fine under
    // @IsOptional() but then blows up in main.ts's getOrThrow().
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) => `  - ${Object.values(error.constraints ?? {}).join('; ')}`,
      )
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill it in.`,
    );
  }

  return parsed;
}
