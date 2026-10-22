import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const TSX = './node_modules/.bin/tsx';

function runTool(name: string, args: any) {
  const stdout = execFileSync(TSX, ['llmcli.ts', '--tool', name, JSON.stringify(args)], { encoding: 'utf8' });
  return stdout;
}

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'llmcli-test-'));
  try {
    // write_file
    const f1 = join(tempDir, 'f1.txt');
    runTool('write_file', { path: f1, content: 'hello world' });
    assert(readFileSync(f1, 'utf8') === 'hello world');

    // read_file
    const outRead = runTool('read_file', { path: f1 });
    assert(outRead.includes('hello world'));

    // insert_lines
    runTool('insert_lines', { path: f1, after_line: 1, new_text: 'line2' });
    assert(readFileSync(f1, 'utf8').includes('hello world\nline2'));

    // replace_lines
    runTool('replace_lines', { path: f1, start_line: 2, end_line: 2, new_text: 'changed' });
    assert(readFileSync(f1, 'utf8').includes('hello world\nchanged'));

    // edit_file
    runTool('edit_file', { path: f1, old_string: 'changed', new_string: 'fixed' });
    assert(readFileSync(f1, 'utf8').includes('hello world\nfixed'));

    // glob_files
    const subDir = join(tempDir, 'sub');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'a.ts'), 'a');
    writeFileSync(join(subDir, 'b.ts'), 'b');
    writeFileSync(join(subDir, 'c.txt'), 'c');
    const outGlob = runTool('glob_files', { path: subDir, pattern: '*.ts' });
    assert(outGlob.includes('a.ts') && outGlob.includes('b.ts') && !outGlob.includes('c.txt'));

    // grep_files
    const outGrep = runTool('grep_files', { path: subDir, pattern: 'a' });
    assert(outGrep.includes('a.ts'));

    // selftest
    const outSelf = execFileSync(TSX, ['llmcli.ts', '--selftest'], { encoding: 'utf8' });
    assert(outSelf.includes('selftest ok'));

    console.log('All tests passed!');
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
