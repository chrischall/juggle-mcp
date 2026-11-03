import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_URL } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const read = (p: string) => JSON.parse(text(p));

// Most of these only fail once a tag exists (npm provenance validates
// repository.url, the registry validates the scoped name and the 100-char
// description, an npm-sourced mcp-host registration reads mint.yaml from the
// tarball) — so assert them up front.
describe('packaging', () => {
  const pkg = read('package.json');

  it('publishes as the public scoped package with a provenance-valid repository', () => {
    expect(pkg.name).toBe('@chrischall/juggle-mcp');
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/juggle-mcp.git');
    expect(pkg.mcpName).toBe('io.github.chrischall/juggle-mcp');
  });

  it('exposes a single unscoped bin pointing at the tsc entry', () => {
    expect(pkg.bin).toEqual({ 'juggle-mcp': 'dist/index.js' });
    expect(read('tsconfig.json').compilerOptions.rootDir).toBe('src');
  });

  it('ships dist, skills, the manifests and mint.yaml', () => {
    for (const f of ['dist', 'skills', '.claude-plugin', '.mcp.json', 'server.json', 'manifest.json', 'mint.yaml']) {
      expect(pkg.files, f).toContain(f);
    }
  });

  it('ships the juggle skill: frontmatter name, an executable helper, its own session file', () => {
    const skill = text('skills/juggle/SKILL.md');
    expect(skill).toMatch(/^---\nname: juggle\ndescription: >-\n/);
    const helper = join(ROOT, 'skills/juggle/scripts/juggle');
    expect(statSync(helper).mode & 0o111, 'helper must be executable').not.toBe(0);
    const src = text('skills/juggle/scripts/juggle');
    expect(src.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(src).toContain('$HOME/.config/juggle/session');
    // Never the MCP's state, never an rm -r of anything.
    expect(src).not.toMatch(/juggle-mcp\/session|rm -r|rm -rf/);
  });

  it('denies install scripts by name, never by pinned version', () => {
    expect(pkg.allowScripts).toEqual({ esbuild: false, fsevents: false });
  });

  it('server.json: registry name, scoped npm identifier, ≤100-char description', () => {
    const server = read('server.json');
    expect(server.name).toBe('io.github.chrischall/juggle-mcp');
    expect(server.packages[0].identifier).toBe('@chrischall/juggle-mcp');
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('the Claude plugin launches the published package via npx (dist/ is gitignored)', () => {
    const server = read('.mcp.json').mcpServers.juggle;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', pkg.name]);
    expect(JSON.stringify(server)).not.toMatch(/dist\//);
    expect(server.env).toEqual({ JUGGLE_EMAIL: '${JUGGLE_EMAIL}', JUGGLE_PASSWORD: '${JUGGLE_PASSWORD}' });
    const plugin = read('.claude-plugin/plugin.json');
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('all version-bearing files agree with package.json', () => {
    const v = pkg.version;
    expect(read('manifest.json').version).toBe(v);
    expect(read('server.json').version).toBe(v);
    expect(read('server.json').packages[0].version).toBe(v);
    expect(read('.claude-plugin/plugin.json').version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').metadata.version).toBe(v);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(v);
    expect(read('.release-please-manifest.json')['.']).toBe(v);
  });

  it('release-please: first release is 0.1.0, 0.x stays 0.x, every version file is bumped', () => {
    const cfg = read('release-please-config.json').packages['.'];
    // 0.0.0 before the first release, then whatever release-please has cut — but
    // never a 1.x by accident (bump-minor-pre-major keeps feat: at 0.x).
    expect(read('.release-please-manifest.json')['.']).toMatch(/^0\.\d+\.\d+$/);
    expect(cfg['package-name']).toBe('@chrischall/juggle-mcp');
    expect(cfg['initial-version']).toBe('0.1.0');
    expect(cfg['bump-minor-pre-major']).toBe(true);
    const extra = JSON.stringify(cfg['extra-files']);
    for (const needle of ['manifest.json', '"$.packages[*].version"', '.claude-plugin/plugin.json', '"$.metadata.version"', '"$.plugins[*].version"', 'src/version.ts']) {
      expect(extra, needle).toContain(needle);
    }
  });

  it('mint.yaml: per-user sign-in fields, egress to the site the client calls, a catalog summary', () => {
    const mint = text('mint.yaml');
    expect(mint).toMatch(/identity:\s*\n(?:\s*#[^\n]*\n)*\s*perUserChild: true/);
    expect(mint).toMatch(/- name: JUGGLE_EMAIL\s*\n\s*label:/);
    expect(mint).toMatch(/- name: JUGGLE_PASSWORD\s*\n\s*label:[^\n]*\n\s*type: password/);
    const allow = mint.match(/egress:\s*\n\s*allow:\s*\n((?:\s*(?:#[^\n]*|-\s*[^\n]+)\n?)+)/);
    expect(allow, 'mint.yaml must declare egress.allow').toBeTruthy();
    const hosts = [...allow![1].matchAll(/^\s*-\s*(\S+)/gm)].map((m) => m[1]);
    expect(hosts).toEqual([new URL(DEFAULT_BASE_URL).host]);
    expect(mint).toMatch(/^summary:/m);
    // An auth field may not also be a host-set env var.
    const envBlock = mint.split(/^env:/m)[1].split(/^\S/m)[0];
    expect(envBlock).not.toMatch(/- name: JUGGLE_(EMAIL|PASSWORD)/);
  });

  it('.gitignore keeps secrets and coverage out; .mcpbignore keeps the .mcpb lean', () => {
    const gi = text('.gitignore');
    for (const line of ['node_modules/', 'dist/', '.env', 'coverage/']) expect(gi.split('\n'), line).toContain(line);
    const mi = text('.mcpbignore').split('\n');
    for (const line of ['src/', 'tests/', 'docs/', 'node_modules/', '.env', 'server.json', 'skills/', 'release-please-config.json', '*.yaml']) {
      expect(mi, line).toContain(line);
    }
  });

  it('dependabot groups vitest with its coverage provider (peer-locked pair)', () => {
    const dep = text('.github/dependabot.yml');
    expect(dep).toMatch(/vitest:\s*\n\s*patterns:\s*\n\s*- "vitest"\s*\n\s*- "@vitest\/coverage-v8"/);
  });

  it('CI stubs call the shared reusable workflows with the status gate', () => {
    for (const f of ['ci.yml', 'pr-auto-review.yml', 'auto-merge.yml', 'release-please.yml', 'claude.yml']) {
      expect(existsSync(join(ROOT, '.github/workflows', f)), f).toBe(true);
    }
    const ci = text('.github/workflows/ci.yml');
    expect(ci).toContain('chrischall/workflows/.github/workflows/reusable-mcp-ci.yml@main');
    expect(ci).toContain('gate-mode: status');
    expect(ci).toContain('statuses: write');
  });
});
