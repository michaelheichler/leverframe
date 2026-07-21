import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

describe('package identity', () => {
  it('publishes only the Leverframe package and executable names', () => {
    expect(pkg.name).toBe('@michaelheichler/leverframe');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.author).toBe('Michael Heichler');
    expect(pkg.description).toContain('OpenAI-compatible providers');
    expect(pkg.bin).toEqual({
      leverframe: 'dist/cli.js',
      'leverframe-claude': 'dist/claude-wrapper.js',
    });
    expect(Object.keys(pkg.bin)).not.toContain('clo' + 'dex');
  });

  it('points package support links at the standalone repository', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/michaelheichler/leverframe.git');
    expect(pkg.homepage).toBe('https://github.com/michaelheichler/leverframe#readme');
    expect(pkg.bugs.url).toBe('https://github.com/michaelheichler/leverframe/issues');
  });
});
