import { zipSync, strToU8 } from 'fflate-modern';
export const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
export const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rels = values => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + values + '</Relationships>';
const relationship = (id, target, type, external = false) => `<Relationship Id="${id}" Target="${target}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}"${external ? ' TargetMode="External"' : ''}/>`;
export const zip = (files, level = 6) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])), { level });
export const syntheticWord = () => zip({
  '[Content_Types].xml': contentTypes,
  '_rels/.rels': rels(relationship('root', 'word/document.xml', 'officeDocument')),
  'word/_rels/document.xml.rels': rels(relationship('style', 'styles.xml', 'styles') + relationship('number', 'numbering.xml', 'numbering') + relationship('image', 'media/image.png', 'image') + relationship('safe', 'https://example.com/article', 'hyperlink', true) + relationship('private', 'https://pocket.example.com/api/tasks/abc/files/secret', 'hyperlink', true)),
  'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  'word/numbering.xml': '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>合成标题</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>重点正文</w:t></w:r><w:hyperlink r:id="safe"><w:r><w:t>安全链接</w:t></w:r></w:hyperlink><w:hyperlink r:id="private"><w:r><w:t>私人能力链接</w:t></w:r></w:hyperlink></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项目</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Synthetic" descr="合成像素"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
    '</w:body></w:document>',
  'word/media/image.png': png,
});
export const syntheticPresentation = () => zip({
  '[Content_Types].xml': contentTypes,
  'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="second"/><p:sldId id="2" r:id="first"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': rels(relationship('first', 'slides/slide1.xml', 'slide') + relationship('second', 'slides/slide2.xml', 'slide')),
  'ppt/slides/slide2.xml': '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>演示标题 &amp; 内容</a:t></a:r></a:p><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>项目一</a:t></a:r><a:br/><a:r><a:t>下一行</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr name="合成图"/></p:nvPicPr><p:blipFill><a:blip r:embed="img"/></p:blipFill></p:pic><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>演示表格</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
  'ppt/slides/_rels/slide2.xml.rels': rels(relationship('img', '../media/image.png', 'image')),
  'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>最后一页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  'ppt/media/image.png': png,
});

