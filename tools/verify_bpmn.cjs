// Artifact QA only: no application or remote system is modified.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const deps = 'C:/Users/luizf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(path.join(deps, 'playwright'));
const sharp = require(path.join(deps, 'sharp'));
const out = path.resolve(__dirname, '../docs/bpmn');
(async () => {
  const browser = await chromium.launch({executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true});
  const page = await browser.newPage({viewport:{width:1500,height:1000}});
  await page.setContent('<html><body><div id="canvas" style="width:3000px;height:1900px"></div></body></html>');
  await page.addScriptTag({path: 'C:/Users/luizf/AppData/Local/Temp/copiloto-bpmn-viewer.js'});
  const results=[];
  for (const file of fs.readdirSync(out).filter(f=>f.endsWith('.bpmn'))) {
    const xml=fs.readFileSync(path.join(out,file),'utf8');
    const result=await page.evaluate(async ({xml})=>{
      const viewer=new BpmnJS({container:'#canvas'});
      const imported=await viewer.importXML(xml);
      const diagrams=viewer.getDefinitions().diagrams;
      const rendered=[];
      for (const diagram of diagrams) {
        await viewer.open(diagram);
        rendered.push((await viewer.saveSVG()).svg);
      }
      viewer.destroy();
      return {warnings:imported.warnings.map(w=>w.message),rendered};
    },{xml});
    if (result.warnings.length) throw new Error(file+': '+result.warnings.join('; '));
    if (!file.startsWith('copiloto')) {
      const base=file.slice(0,-5);
      fs.writeFileSync(path.join(out,base+'.svg'),result.rendered[0]);
      await sharp(Buffer.from(result.rendered[0])).flatten({background:'#ffffff'}).png().toFile(path.join(out,base+'.png'));
      await sharp(Buffer.from(result.rendered[0])).flatten({background:'#ffffff'}).resize({width:1800}).png().toFile(path.join(out,base+'-preview.png'));
    }
    results.push({file,import:'PASS',warnings:[],diagrams:result.rendered.length});
  }
  let idx=0;
  const svgs=fs.readdirSync(out).filter(f=>/^0[1-4].*\.svg$/.test(f)).map(f=>fs.readFileSync(path.join(out,f),'utf8'));
  const preview=path.join(out,'visualizar.html');
  const html=fs.readFileSync(preview,'utf8').replace(/<div class="diagram">[\s\S]*?<\/div>/g,()=>'<div class="diagram">'+svgs[idx++]+'</div>');
  fs.writeFileSync(preview,html);
  await page.goto(pathToFileURL(preview).href);
  await page.screenshot({path:path.join(out,'visualizacao-preview.png'),fullPage:true});
  await browser.close();
  fs.writeFileSync(path.join(out,'validacao-visualizador.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
