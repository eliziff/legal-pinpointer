import {cancelled} from './core.mjs';

// Temporal status and attribution are not mutually exclusive: every row remains
// a source assertion. Do not make 'reported' compete with 'completed'.
export async function judgeEvent(row, source, decisions, signal) {
  cancelled(signal);
  const block=source.blocks.find(b=>b.id===row.blockId);
  if(!block)throw new Error('The event source block is missing.');
  const original=block.text.slice(row.start,row.end);
  const at=row.dateOffset==null?null:row.dateOffset-row.start;
  let begin=0,end=original.length;
  // Keep the particular date occurrence attached to its own contrast clause.
  if(at!==null)for(const match of original.matchAll(/;|,?\s+but\s+/giu)) {
    if(match.index+match[0].length<=at)begin=match.index+match[0].length;
    else if(match.index>at){end=match.index;break;}
  }
  const state=original.slice(begin,end).trim();
  const answer=await decisions.decide(state,{type:'choice',
    instructions:'What is the status of the event described here?',
    criteria:{completed:'Already happened',planned:'Scheduled for the future',requested:'Asked for but not completed',denied:'Did not happen'}},signal);
  let status=answer.choice,basis='model';
  // Explicit syntactic guards, not a substitute for semantic inference.
  if(/\b(?:if|unless|provided that|subject to)\b/iu.test(state)) {status='conditional';basis='explicit condition';}
  else if(/\b(?:did not|never|has not|have not|had not|was not|were not|didn't|wasn't|weren't|hasn't|haven't|hadn't)\b/iu.test(state)){status='denied';basis='explicit negation';}
  else if(/\b(?:requested|requesting|asked|asking)\b/iu.test(state)) {status='requested';basis='explicit request';}
  else {
    const probabilities=Object.values(answer.probabilities).sort((a,b)=>b-a);
    // A review threshold, not a calibrated probability guarantee. In particular,
    // terse PDF fragments can produce closely competing completed/denied logits.
    if(probabilities[0]<.5||probabilities[0]-probabilities[1]<.2){status='unclear';basis='weak model separation';}
  }
  return {status,basis,modelChoice:answer.choice,probabilities:answer.probabilities,
    targetStart:row.start+begin,targetEnd:row.start+end};
}
