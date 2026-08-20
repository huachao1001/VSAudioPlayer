// 从 media/icon.svg 渲染出 256×256 的 media/icon.png
const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')

const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'media', 'icon.svg')
const pngPath = path.join(root, 'media', 'icon.png')

const svg = fs.readFileSync(svgPath)
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 256 },
  background: 'transparent',
})
const png = resvg.render().asPng()
fs.writeFileSync(pngPath, png)
console.log('wrote', path.relative(root, pngPath), png.length, 'bytes')
