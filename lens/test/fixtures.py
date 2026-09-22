from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq
root=Path(__file__).parent/'fixtures';root.mkdir(exist_ok=True)
for name, rows in {
 'cases.parquet':[{'dataset':'SCC','name_en':f'Fixture {i}','citation_en':f'2026 TEST {i}','unofficial_text_en':('Unrelated background.' if i<230 else 'The indemnity expressly includes negligence of the protected party.'),'unofficial_text_fr':('Texte sans rapport.' if i<230 else 'Cette indemnité vise la négligence de la partie protégée.'),'url_en':'https://example.invalid/fixture','document_date_en':'2026-03-10'} for i in range(231)],
 'laws.parquet':[{'dataset':'LEGISLATION-FED','name_en':'Fixture Act','unofficial_text_en':'Notice takes effect only upon receipt, not dispatch.','unofficial_text_fr':'L’avis prend effet à sa réception.','document_date_en':'2026-03-11'}],
 'hansard.parquet':[{'ID':'fixture-speech','Date':'2026-03-12','jurisdiction':'ontario','Intervention':'The Minister discusses actual receipt of notice.','PersonSpeaking':'Example Speaker','SubjectofBusiness':'Notice','source_url':'https://example.invalid/hansard'}]
}.items():pq.write_table(pa.Table.from_pylist(rows),root/name,row_group_size=31)
(root/'sample.eml').write_text('From: Jordan Example <jordan@example.invalid>\nDate: Thu, 12 Mar 2026 10:00:00 -0600\nSubject: Fixture\nContent-Type: text/plain; charset=utf-8\n\nThe courier collected the notice on 10 March 2026. Delivery is scheduled for 13 March 2026.\n')

from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile(root/'sample.docx','w',ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">Delivery is scheduled for </w:t></w:r><w:del><w:r><w:delText>15</w:delText></w:r></w:del><w:ins><w:r><w:t>13</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> March 2026.</w:t></w:r></w:p></w:body></w:document>')
def pdf(target, objects):
 data=bytearray(b'%PDF-1.4\n');offsets=[0]
 for i,obj in enumerate(objects,1):
  offsets.append(len(data));data+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
 xref=len(data);data+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
 for offset in offsets[1:]:data+=f'{offset:010d} 00000 n \n'.encode()
 data+=f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode();target.write_bytes(data)
def stream(data):return f'<< /Length {len(data)} >>\nstream\n'.encode()+data+b'\nendstream'
pdf(root/'sample.pdf',[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',stream(b'BT /F1 18 Tf 40 140 Td (Collected on 10 March 2026.) Tj ET'),b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'])
from PIL import Image,ImageDraw,ImageFont
from io import BytesIO
im=Image.new('RGB',(1400,220),'white');ImageDraw.Draw(im).text((65,80),'Delivery is scheduled for 13 March 2026.',font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',42),fill='black');buf=BytesIO();im.save(buf,format='JPEG',quality=95);jpeg=buf.getvalue()
pdf(root/'scan.pdf',[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 110] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',stream(b'q 700 0 0 110 0 0 cm /Im0 Do Q'),f'<< /Type /XObject /Subtype /Image /Width 1400 /Height 220 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>\nstream\n'.encode()+jpeg+b'\nendstream'])
