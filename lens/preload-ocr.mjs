import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
// Package the core in the worker itself. file:// workers cannot reliably import
// a blob URL belonging to a different opaque origin.
const dir=path.join(import.meta.dirname,'node_modules/tesseract.js/dist');
const core=path.join(import.meta.dirname,'node_modules/tesseract.js-core');
const name='tesseract-core-simd-lstm';
let code=await readFile(path.join(core,name+'.wasm.js'),'utf8');
const uri='data:application/octet-stream;base64,'+(await readFile(path.join(core,name+'.wasm'))).toString('base64');
code=code.replaceAll('"'+name+'.wasm"',()=>JSON.stringify(uri)).replaceAll("'"+name+".wasm'",()=>JSON.stringify(uri));
if(!code.includes(uri))throw new Error('OCR core asset reference changed.');
const file=path.join(dir,'worker.min.js'),worker=await readFile(file,'utf8');
if(!worker.startsWith('/* packaged OCR core */'))await writeFile(file,'/* packaged OCR core */\n'+code+'\nself.TesseractCore=TesseractCore;\n'+worker);
