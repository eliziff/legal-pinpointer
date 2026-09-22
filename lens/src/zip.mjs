// An original DOCX inside a saved session is itself a ZIP. Locate the outer
// end-of-directory record, not the first signature occurring inside a member.
export function boundedZip(bytes) {
  const v=new DataView(bytes),length=bytes.byteLength;
  let end=-1;
  for(let p=length-22;p>=Math.max(0,length-65557);p--){
    if(v.getUint32(p,true)===0x06054b50 && p+22+v.getUint16(p+20,true)===length){end=p;break;}
  }
  if(end<0)throw new Error('Missing ZIP directory.');
  if(v.getUint16(end+4,true)||v.getUint16(end+6,true))throw new Error('Multi-volume ZIP packages are not supported.');
  const count=v.getUint16(end+10,true),size=v.getUint32(end+12,true),offset=v.getUint32(end+16,true);
  if(count===65535||offset===0xffffffff||size===0xffffffff)throw new Error('ZIP64 document packages are not supported.');
  if(count>10000)throw new Error('Document package has more than 10,000 parts.');
  if(offset+size!==end)throw new Error('Invalid ZIP directory bounds.');
  let at=offset,total=0;
  for(let i=0;i<count;i++){
    if(at+46>end||v.getUint32(at,true)!==0x02014b50)throw new Error('Invalid ZIP directory.');
    const expanded=v.getUint32(at+24,true);total+=expanded;
    if(expanded>128*1024*1024||total>512*1024*1024)throw new Error('Expanded document package exceeds the 512 MB safety budget.');
    at+=46+v.getUint16(at+28,true)+v.getUint16(at+30,true)+v.getUint16(at+32,true);
    if(at>end)throw new Error('Invalid ZIP member bounds.');
  }
  if(at!==end)throw new Error('ZIP directory count does not match its size.');
}
