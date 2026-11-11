// Small source-generated fixture: no private document, embedded links or attachments.
export function syntheticPreviewPdf({ pages = 3, largePage = false } = {}) {
  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  const catalog = add(''), tree = add('');
  const latin = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const cjk = add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>');
  add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
  const children = [];
  for (let index = 0; index < pages; index++) {
    const text = `BT /F1 24 Tf 40 700 Td (Pocket PDF page ${index + 1}) Tj /F2 24 Tf 0 -45 Td <4e2d65876d4b8bd5> Tj ET`;
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    const mediaBox = largePage ? '0 0 15000 15000' : '0 0 595 842';
    children.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [${mediaBox}] /Resources << /Font << /F1 ${latin} 0 R /F2 ${cjk} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Count ${pages} /Kids [${children.map(id => `${id} 0 R`).join(' ')}] >>`;
  let result = '%PDF-1.7\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
