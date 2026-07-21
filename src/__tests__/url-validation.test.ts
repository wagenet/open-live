import { describe, it, expect } from 'vitest';
import { srtUrl, httpUrlOnly, graphicUrl } from '../lib/url-validation.js';

describe('srtUrl', () => {
  it('accepts valid srt:// URL with host and port', () => {
    expect(() => srtUrl('srt://host.example.com:9999')).not.toThrow();
  });

  it('accepts srt:// with empty host (bind all interfaces)', () => {
    expect(() => srtUrl('srt://:9999')).not.toThrow();
  });

  it('accepts srt:// with safe query params', () => {
    expect(() => srtUrl('srt://host.example.com:9999?passphrase=abc123&mode=caller')).not.toThrow();
  });

  it('accepts IPv6 bracketed address', () => {
    expect(() => srtUrl('srt://[::1]:9999')).not.toThrow();
  });

  it('rejects CR/LF injection in query string', () => {
    expect(() => srtUrl('srt://host:9999?x=a\r\ninjected=1')).toThrow('Control characters not allowed');
  });

  it('rejects LF alone', () => {
    expect(() => srtUrl('srt://host:9999?x=a\ninjected')).toThrow('Control characters not allowed');
  });

  it('rejects NUL byte', () => {
    expect(() => srtUrl('srt://host:9999?x=\x00')).toThrow('Control characters not allowed');
  });

  it('rejects wrong scheme', () => {
    expect(() => srtUrl('http://host:9999')).toThrow('Invalid SRT URL format');
  });

  it('rejects URL with no port', () => {
    expect(() => srtUrl('srt://host.example.com')).toThrow('Invalid SRT URL format');
  });

  it('rejects URL exceeding max length', () => {
    expect(() => srtUrl('srt://host:9999?' + 'a'.repeat(600))).toThrow('SRT URL too long');
  });

  it('rejects backslash in query string', () => {
    expect(() => srtUrl('srt://host:9999?x=a\\b')).toThrow('Invalid SRT URL format');
  });

  it('rejects quotes in query string', () => {
    expect(() => srtUrl('srt://host:9999?x="evil"')).toThrow('Invalid SRT URL format');
  });
});

describe('httpUrlOnly', () => {
  it('accepts http URLs', () => {
    expect(() => httpUrlOnly('http://example.com')).not.toThrow();
  });

  it('accepts https URLs', () => {
    expect(() => httpUrlOnly('https://example.com/path')).not.toThrow();
  });

  it('rejects file:// scheme', () => {
    expect(() => httpUrlOnly('file:///etc/passwd')).toThrow('Disallowed URL scheme');
  });

  it('rejects javascript: scheme', () => {
    expect(() => httpUrlOnly('javascript:alert(1)')).toThrow();
  });

  it('rejects invalid URL', () => {
    expect(() => httpUrlOnly('not-a-url')).toThrow('Invalid URL');
  });
});

describe('graphicUrl', () => {
  it('accepts https URL', () => {
    expect(() => graphicUrl('https://example.com/overlay.png')).not.toThrow();
  });

  it('accepts data:image/png URI', () => {
    expect(() => graphicUrl('data:image/png;base64,abc123')).not.toThrow();
  });

  it('rejects javascript: scheme', () => {
    expect(() => graphicUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects file:// scheme', () => {
    expect(() => graphicUrl('file:///etc/passwd')).toThrow();
  });
});
