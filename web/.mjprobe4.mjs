import { init } from 'mathjax/node-main.mjs';
const out = [];
const log = (...a) => out.push(a.map(x => typeof x === 'string' ? x.slice(0,300) : String(x).slice(0,300)).join(' '));
try {
  const MJ = await init({
    loader: { paths: { fonts: '/tmp/fontsEmpty' } },
    output: { font: 'mathjax-newcm' },
    tex: { packages: { '[+]': ['mhchem'] } },
    startup: { typeset: false }
  });
  const doc = MJ.startup.document;
  const n = doc.convert('À + \\int_0^1 x^2\\,dx', { display: true });
  const html = MJ.startup.adaptor.outerHTML(n);
  log('convert len', html.length, 'paths', (html.match(/<path/g)||[]).length, 'texts', (html.match(/<text/g)||[]).length);
} catch (e) {
  log('ERR', e.message);
}
import('node:fs').then(fs => fs.writeFileSync('/tmp/mjprobe4.out', out.join('\n')));
