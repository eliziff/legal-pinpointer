// machine_test; run identifier accompanies every request and response.
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const pin = process.env.EVAL_PINPOINTER_ROOT ? pathToFileURL(process.env.EVAL_PINPOINTER_ROOT.replace(/\/$/,'') + '/lens/src/core.mjs') : new URL('../../legal-pinpointer/lens/src/core.mjs',import.meta.url);
const ocr = process.env.EVAL_OCR_ROOT ? pathToFileURL(process.env.EVAL_OCR_ROOT.replace(/\/$/,'') + '/text-layer.js') : new URL('../../legal-browser-ocr/text-layer.js',import.meta.url);
const core=await import(pin), layer=await import(ocr);
const emit=value=>process.stdout.write(JSON.stringify(value).replace(/[\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16))+'\n');
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  let request;
  try {
    request=JSON.parse(line);
    if(request.submission_origin!=='machine_test' || !request.run_id) throw new Error('Missing machine_test provenance/run identifier');
    let value;
    switch(request.operation) {
      case 'paragraph':value=[...core.paragraphSpans(request.text)];break;
      case 'passage':
        if(!Number.isSafeInteger(request.max_chars)||request.max_chars<2) throw new Error('Frozen evaluator requires an integer budget of at least two');
        value=core.passageWindows(request.text,request.max_chars);break;
      case 'normalization':value={norm:core.norm(request.text),words:core.words(request.text)};break;
      case 'clean':value=layer.cleanModelText(request.text);break;
      case 'positioned':value=layer.positionedLines(request.lines,request.texts);break;
      default:throw new Error('Unknown operation');
    }
    emit({id:request.id,run_id:request.run_id,ok:true,value,unicode_hex:layer.unicodeHex(request.text)});
  } catch(error) {
    emit({id:request?.id,run_id:request?.run_id,ok:false,error:String(error?.stack||error)});
  }
}
