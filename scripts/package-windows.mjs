import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function ignorePackageFile(filePath) {
  const relative = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!relative) return false;
  if (relative === 'scripts' || relative === 'scripts/windows-smoke.cjs') return false;
  if (['package.json', 'README.md', 'LICENSE'].includes(relative)) return false;
  return !/^(src|electron)(\/|$)/.test(relative);
}

export async function packageWindows() {
  const output = await packager({
    dir: projectRoot,
    name: 'ClinicCharge',
    platform: 'win32',
    arch: 'x64',
    out: path.join(projectRoot, 'release'),
    overwrite: true,
    asar: true,
    prune: true,
    ignore: ignorePackageFile,
    win32metadata: {
      ProductName: '门诊收费录入打印软件',
      FileDescription: '门诊收费录入打印软件',
    },
  });
  console.log(`Windows 程序已生成：${output.join(', ')}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await packageWindows();
}
