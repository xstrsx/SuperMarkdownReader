import { init } from 'mathjax/node-main.mjs';
const fontsPath = new URL('./node_modules/@mathjax/', import.meta.url).pathname.replace(/\/$/,'');
async function tryVariant(label, cfg) {
  try {
    const MJ = await init(cfg);
    const keys = Object.keys(MJ).filter(k=>/svg|chtml|typeset|tex/i.test(k));
    console.log(label, 'INIT OK keys=', keys.join(','));
    if (MJ.tex2svgPromise) {
      const n = await MJ.tex2svgPromise('\\int_0^1 \\frac{x^2}{\\sqrt{1-x^2}}\\,dx + \\mathfrak{A}\\mathbb{N}', {display:true});
      const out = MJ.startup.adaptor.outerHTML(n);
      console.log('   svg paths=', (out.match(/<path/g)||[]).length, 'texts=', (out.match(/<text/g)||[]).length, 'len=', out.length);
    }
    return MJ;
  } catch(e) { console.log(label, 'INIT FAIL', e.message); return null; }
}
await tryVariant('A output.load svg', { loader: { paths: { fonts: fontsPath }, load: ['output/svg'] }, output: { font: 'mathjax-newcm' }, startup: { typeset: false } });
await tryVariant('B startup.output svg', { loader: { paths: { fonts: fontsPath } }, startup: { typeset: false, output: 'svg' } });
await tryVariant('C output.jax?', { loader: { paths: { fonts: fontsPath } }, output: { font: 'mathjax-newcm', jax: 'svg' }, startup: { typeset: false } });
