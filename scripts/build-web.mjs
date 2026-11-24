// Builds the dashboard in web/ and puts the result at the project root, where GitHub Pages
// serves it. Run from anywhere:
//     node scripts/build-web.mjs
// Vite is started through node directly, because the "&" in the folder name breaks npx.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const web = join(root, 'web')
const dist = join(web, 'dist')

execFileSync(process.execPath, [join(web, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', web], { stdio: 'inherit' })
if (!existsSync(join(dist, 'index.html'))) throw new Error('The build made no index.html, nothing copied.')

// Old built files have different names each time, so clear them before copying the new ones.
rmSync(join(root, 'assets'), { recursive: true, force: true })
cpSync(dist, root, { recursive: true })
console.log('Copied the build to the project root.')
