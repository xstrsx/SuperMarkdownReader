import { init } from 'mathjax/node-main.mjs';
const fontsPath = new URL('./node_modules/@mathjax/', import.meta.url).pathname.replace(/\/$/,'');
const MJ = await init({ loader: { paths: { fonts: fontsPath } }, output: { font: 'mathjax-newcm' }, startup: { typeset: false } });
console.log('keys:', Object.keys(MJ).join(','));
console.log('startup keys:', Object.keys(MJ.startup).join(','));
console.log('output:', MJ.startup.output?.name, 'input:', MJ.startup.input?.name, 'adaptor:', !!MJ.startup.adaptor, 'handler:', !!MJ.startup.handler);
const doc = MJ.startup.document;
console.log('document keys:', Object.keys(doc).join(','));
if (doc.convert) {
  const n = doc.convert('\\int_0^1 \\frac{x^2}{\\sqrt{1-x^2}}\\,dx + \\mathfrak{A}\\mathbb{N}\\varphi', { display: true });
  const out = MJ.startup.adaptor.outerHTML(n);
  console.log('convert ok len=', out.length, 'paths=', (out.match(/<path/g)||[]).length, 'texts=', (out.match(/<text/g)||[]).length);
  console.log(out.slice(0, 400));
}
