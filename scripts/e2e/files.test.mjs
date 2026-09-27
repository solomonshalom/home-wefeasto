/*
 * Unit tests for the CMS build-cache key (cmsBuildKey) and the tsconfig guard around
 * `next build` (guardNextBuildFiles). They run against throwaway CMS dirs; the last test
 * checks the real cms/ so the key and the guard can't drift from next.config.ts.
 *
 * Run: node --test scripts/e2e/files.test.mjs   (or npm run test:e2e:harness)
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmsTsconfigFiles, guardNextBuildFiles } from './files.mjs';
import { cmsBuildKey, migrationNames } from './cms.mjs';
import { CMS_DIR } from './config.mjs';

const CFG = { distDir: '.next-e2e-3', cmsUrl: 'http://127.0.0.1:3703', sfUrl: 'http://127.0.0.1:4703' };
const TSCONFIG = '{\n  "compilerOptions": { "strict": true },\n  "include": ["next-env.d.ts", "**/*.ts", ".next/types/**/*.ts"]\n}\n';
const TSBUILD = '{\n  "extends": "./tsconfig.json",\n  "exclude": ["node_modules", "media", "tests", "vitest.config.mts"]\n}\n';

let dir;
const file = (name) => path.join(dir, name);
const write = (name, text) => fs.writeFileSync(file(name), text);
const read = (name) => fs.readFileSync(file(name), 'utf8');
const key = () => cmsBuildKey(CFG, dir);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e2e-files-'));
	fs.mkdirSync(file('src'));
	write('src/payload.config.ts', 'export default {}\n');
	write('next.config.ts', "export default { typescript: { tsconfigPath: 'tsconfig.build.json' } }\n");
	write('package.json', '{}\n');
	write('tsconfig.json', TSCONFIG);
	write('tsconfig.build.json', TSBUILD);
	write('next-env.d.ts', '/// <reference types="next" />\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('cmsTsconfigFiles lists tsconfig.json, tsconfig.build.json and other tsconfig*.json at the root only', () => {
	write('tsconfig.tests.json', '{}');
	write('tsconfig-notes.txt', 'x');
	fs.mkdirSync(file('src/sub'));
	fs.writeFileSync(file('src/sub/tsconfig.json'), '{}');
	assert.deepEqual(cmsTsconfigFiles(dir), ['tsconfig.build.json', 'tsconfig.json', 'tsconfig.tests.json']);
	fs.rmSync(file('tsconfig.build.json'));
	assert.ok(cmsTsconfigFiles(dir).includes('tsconfig.build.json'), 'still listed when missing, so deleting it changes the key');
});

test('cmsBuildKey changes when tsconfig.build.json changes (HARN-1)', () => {
	const k0 = key();
	assert.equal(key(), k0, 'stable');
	write('tsconfig.build.json', TSBUILD.replace('"tests", ', ''));
	const k1 = key();
	assert.notEqual(k1, k0, 'dropping tests from exclude busts the cache');
	write('tsconfig.build.json', TSBUILD.replace('"exclude"', '"compilerOptions": { "strict": false },\n  "exclude"'));
	assert.notEqual(key(), k0, 'a strictness change busts the cache');
	assert.notEqual(key(), k1);
	write('tsconfig.build.json', TSBUILD);
	assert.equal(key(), k0, 'restoring the bytes restores the key');
	fs.rmSync(file('tsconfig.build.json'));
	assert.notEqual(key(), k0, 'deleting it busts the cache');
});

test('cmsBuildKey ignores the .next-*/types includes another slot\'s build adds, in either tsconfig', () => {
	const k0 = key();
	write('tsconfig.json', TSCONFIG.replace('".next/types/**/*.ts"', '".next/types/**/*.ts", ".next-e2e-1/types/**/*.ts", ".next-e2e-1/dev/types/**/*.ts"'));
	assert.equal(key(), k0, 'tsconfig.json');
	write('tsconfig.json', TSCONFIG);
	// An include of only dist types on tsconfig.build.json (which has none) normalises to no include.
	write('tsconfig.build.json', TSBUILD.replace('"exclude"', '"include": [".next-e2e-4/types/**/*.ts", ".next-e2e-4/dev/types/**/*.ts"],\n  "exclude"'));
	assert.equal(key(), k0, 'tsconfig.build.json with a dist-types-only include');
	// A real include is a program change; dist-types entries next to it are still ignored.
	write('tsconfig.build.json', TSBUILD.replace('"exclude"', '"include": ["src/**/*.ts"],\n  "exclude"'));
	const kInc = key();
	assert.notEqual(kInc, k0);
	write('tsconfig.build.json', TSBUILD.replace('"exclude"', '"include": ["src/**/*.ts", ".next-e2e-4/types/**/*.ts"],\n  "exclude"'));
	assert.equal(key(), kInc, 'tsconfig.build.json with a real include');
	write('tsconfig.build.json', TSBUILD.replace('"exclude"', '"include": [],\n  "exclude"'));
	assert.notEqual(key(), k0, 'an explicit empty include is kept (it is a real, if broken, program)');
});

test('cmsBuildKey still covers tsconfig.json, src and next.config.ts', () => {
	const k0 = key();
	write('tsconfig.json', TSCONFIG.replace('"strict": true', '"strict": false'));
	assert.notEqual(key(), k0);
	write('tsconfig.json', TSCONFIG);
	write('src/payload.config.ts', 'export default { x: 1 }\n');
	assert.notEqual(key(), k0);
	write('src/payload.config.ts', 'export default {}\n');
	write('next.config.ts', 'export default {}\n');
	assert.notEqual(key(), k0);
});

/** What `next build` would do to a tsconfig for our distDir: add its types dirs to "include". */
function nextAddsTypes(name, distDir = CFG.distDir) {
	const cfg = JSON.parse(read(name));
	const parent = name === 'tsconfig.json' ? [] : JSON.parse(read('tsconfig.json')).include;
	cfg.include = [...(cfg.include || parent), `${distDir}/types/**/*.ts`, `${distDir}/dev/types/**/*.ts`];
	write(name, JSON.stringify(cfg, null, 2) + '\n');
}

test('guardNextBuildFiles restores tsconfig.build.json byte-for-byte after Next adds an include (HARN-1)', () => {
	const guard = guardNextBuildFiles(dir, CFG.distDir);
	nextAddsTypes('tsconfig.build.json');
	assert.notEqual(read('tsconfig.build.json'), TSBUILD);
	assert.deepEqual(guard.restore(), ['cms/tsconfig.build.json restored byte-for-byte']);
	assert.equal(read('tsconfig.build.json'), TSBUILD);
	assert.equal(read('tsconfig.json'), TSCONFIG, 'untouched');
	assert.deepEqual(guard.restore(), [], 'restore is idempotent');
});

test('guardNextBuildFiles restores both tsconfigs and next-env.d.ts when a build touches all three', () => {
	const env = read('next-env.d.ts');
	const guard = guardNextBuildFiles(dir, CFG.distDir);
	nextAddsTypes('tsconfig.json');
	write('tsconfig.build.json', TSBUILD.replace('"extends"', '"include": ["src/**/*.ts", "./.next-e2e-3/types/**/*.ts"],\n  "extends"'));
	write('next-env.d.ts', env + 'import "./.next-e2e-3/types/routes.d.ts";\n');
	assert.deepEqual(guard.restore().sort(), [
		'cms/next-env.d.ts restored byte-for-byte',
		'cms/tsconfig.build.json restored byte-for-byte',
		'cms/tsconfig.json restored byte-for-byte'
	]);
	assert.equal(read('tsconfig.json'), TSCONFIG);
	assert.equal(read('tsconfig.build.json'), TSBUILD);
	assert.equal(read('next-env.d.ts'), env);
});

test('guardNextBuildFiles keeps a concurrent edit to tsconfig.build.json and removes only our entries', () => {
	const guard = guardNextBuildFiles(dir, CFG.distDir);
	// Someone un-excludes tests/ during the build, and Next adds our types to the same file.
	write('tsconfig.build.json', TSBUILD.replace('"tests", ', ''));
	nextAddsTypes('tsconfig.build.json');
	const [note, ...rest] = guard.restore();
	assert.deepEqual(rest, []);
	assert.match(note, /^WARNING: cms\/tsconfig\.build\.json was also changed by another process during the build; removed only our \.next-e2e-3 entries$/);
	const now = JSON.parse(read('tsconfig.build.json'));
	assert.deepEqual(now.exclude, ['node_modules', 'media', 'vitest.config.mts'], 'their edit survives');
	assert.equal(now.include, undefined, 'the include Next added is gone, so it inherits tsconfig.json\'s again');
	assert.equal(now.extends, './tsconfig.json');
});

test('guardNextBuildFiles leaves unchanged files alone and never touches another slot\'s entries', () => {
	const guard = guardNextBuildFiles(dir, CFG.distDir);
	nextAddsTypes('tsconfig.build.json', '.next-e2e-1'); // another slot, not us
	const [note] = guard.restore();
	assert.match(note, /^WARNING: cms\/tsconfig\.build\.json was also changed/);
	assert.ok(JSON.parse(read('tsconfig.build.json')).include.includes('.next-e2e-1/types/**/*.ts'));
	assert.equal(read('tsconfig.json'), TSCONFIG);
});

test('the real cms/: next.config.ts tsconfigPath is hashed and guarded, and extends tsconfig.json', () => {
	const src = fs.readFileSync(path.join(CMS_DIR, 'next.config.ts'), 'utf8');
	const m = src.match(/tsconfigPath:\s*['"]([^'"]+)['"]/);
	const tsconfigPath = m ? m[1] : 'tsconfig.json';
	assert.ok(fs.existsSync(path.join(CMS_DIR, tsconfigPath)), `${tsconfigPath} exists`);
	assert.ok(cmsTsconfigFiles(CMS_DIR).includes(path.basename(tsconfigPath)), `${tsconfigPath} is in the build key and the guard`);
	assert.equal(path.dirname(tsconfigPath), '.', 'cmsTsconfigFiles only looks at the CMS root');
	if (tsconfigPath !== 'tsconfig.json') {
		const build = JSON.parse(fs.readFileSync(path.join(CMS_DIR, tsconfigPath), 'utf8'));
		assert.equal(build.extends, './tsconfig.json', 'tsconfig.json edits reach the build program (already hashed)');
	}
	assert.match(cmsBuildKey(CFG), /^[0-9a-f]{64}$/);
});

test('migrationNames reads the generated index.ts; a new migration changes the CMS build key (prodMigrations is bundled)', () => {
	fs.mkdirSync(file('src/migrations'));
	assert.deepEqual(migrationNames(dir), []);
	write('src/migrations/index.ts', "import * as m1 from './20260101_000000_init';\n\nexport const migrations = [\n  {\n    up: m1.up,\n    down: m1.down,\n    name: '20260101_000000_init'\n  },\n];\n");
	const before = key();
	write('src/migrations/20260102_000000_add_x.ts', 'export async function up() {}\n');
	write('src/migrations/index.ts', read('src/migrations/index.ts').replace('];', "  { up: m2.up, down: m2.down, name: \"20260102_000000_add_x\" },\n];"));
	assert.deepEqual(migrationNames(dir), ['20260101_000000_init', '20260102_000000_add_x']);
	assert.notEqual(key(), before);
});

test('the real cms/: index.ts registers every migration file (E2E_SCHEMA=migrate, the default, applies them)', () => {
	const files = fs.readdirSync(path.join(CMS_DIR, 'src/migrations')).filter((f) => /\.(ts|js)$/.test(f) && !/^index\./.test(f)).map((f) => f.replace(/\.(ts|js)$/, ''));
	assert.ok(files.length > 0, 'cms/src/migrations has at least the initial migration');
	assert.deepEqual([...migrationNames()].sort(), files.sort());
});
