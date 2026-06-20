// Unit tests for the OTel enablement policy. Pure helpers, no SDK.
import { describe, expect, it } from 'vitest';
import { shouldEnableOtel, otlpTraceEndpoint, promExporterHost, truthyFlag, falsyFlag } from './otelConfig.js';

describe('shouldEnableOtel', () => {
  it('is ON by default in production (staging/prod run as production)', () => {
    expect(shouldEnableOtel(undefined, 'production')).toBe(true);
    expect(shouldEnableOtel('', 'production')).toBe(true);
  });

  it('is OFF by default outside production', () => {
    expect(shouldEnableOtel(undefined, 'development')).toBe(false);
    expect(shouldEnableOtel(undefined, 'test')).toBe(false);
    expect(shouldEnableOtel('', undefined)).toBe(false);
  });

  it('honours an explicit opt-in anywhere', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(shouldEnableOtel(v, 'development')).toBe(true);
    }
  });

  it('honours an explicit opt-out anywhere (prod rollback)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF']) {
      expect(shouldEnableOtel(v, 'production')).toBe(false);
    }
  });

  it('treats an unrecognised value as unset (falls back to the env default)', () => {
    expect(shouldEnableOtel('maybe', 'production')).toBe(true);
    expect(shouldEnableOtel('maybe', 'development')).toBe(false);
  });
});

describe('otlpTraceEndpoint', () => {
  it('returns a trimmed endpoint when set', () => {
    expect(otlpTraceEndpoint('http://collector:4318')).toBe('http://collector:4318');
    expect(otlpTraceEndpoint('  http://c:4318  ')).toBe('http://c:4318');
  });

  it('returns null when unset/blank so the SDK runs metrics-only', () => {
    expect(otlpTraceEndpoint(undefined)).toBeNull();
    expect(otlpTraceEndpoint('')).toBeNull();
    expect(otlpTraceEndpoint('   ')).toBeNull();
  });
});

describe('promExporterHost', () => {
  it('defaults to loopback so /metrics is private off-box', () => {
    expect(promExporterHost(undefined)).toBe('127.0.0.1');
    expect(promExporterHost('')).toBe('127.0.0.1');
    expect(promExporterHost('   ')).toBe('127.0.0.1');
  });

  it('honours an explicit bind host for a private-network scraper', () => {
    expect(promExporterHost('0.0.0.0')).toBe('0.0.0.0');
    expect(promExporterHost('10.1.2.3')).toBe('10.1.2.3');
    expect(promExporterHost('  10.0.0.5  ')).toBe('10.0.0.5');
  });
});

describe('flag parsers', () => {
  it('truthyFlag / falsyFlag recognise the documented spellings', () => {
    expect(truthyFlag('Yes')).toBe(true);
    expect(truthyFlag('0')).toBe(false);
    expect(falsyFlag('No')).toBe(true);
    expect(falsyFlag('1')).toBe(false);
  });
});
