import { init } from 'mathjax/node-main.mjs';
const fontsPath = new URL('./node_modules/@mathjax/', import.meta.url).pathname.replace(/\/$/,'');
const MathJax = await init({
  loader: { paths: { fonts: fontsPath }, load: ['[tex]/mhchem','[tex]/physics','[tex]/units','[tex]/color','[tex]/boldsymbol'] },
  tex: { packages: { '[+]': ['mhchem','physics','units','color','boldsymbol','html','textmacros'] }, tags: 'ams' },
  output: { font: 'mathjax-newcm' },
  startup: { typeset: false }
});
const cases = [
  ['mhchem', '\\ce{2H2 + O2 -> 2H2O}'],
  ['mhchem2', '\\ce{N2 + 3H2 <=>[Fe][\\Delta] 2NH3}'],
  ['int', '\\int_0^1 \\frac{x^2}{\\sqrt{1-x^2}}\\,dx'],
  ['frak', '\\mathfrak{A}\\mathbb{N}\\mathcal{L}\\varphi\\aleph'],
  ['align', '\\begin{aligned} a+b &= c \\\\ x+y &= z \\end{aligned}'],
  ['ref', '\\label{eq:one}E=mc^2']
];
for (const [name, tex] of cases) {
  try {
    const node = await MathJax.tex2svgPromise(tex, { display: true });
    const out = MathJax.startup.adaptor.outerHTML(node);
    const paths = (out.match(/<path/g) || []).length;
    const texts = (out.match(/<text/g) || []).length;
    console.log(`${name}: ok bytes=${out.length} paths=${paths} texts=${texts}`);
  } catch (e) {
    console.log(`${name}: ERROR ${e.message}`);
  }
}
