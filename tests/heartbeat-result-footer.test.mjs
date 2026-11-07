import test,{after} from 'node:test';import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {createServer} from 'vite';import {fileURLToPath} from 'node:url';
import {readableHeartbeatResultSuffix,projectStructuredMessage} from '../src/messageEnvelope.ts';
import {readableHeartbeatMessage} from '../src/heartbeatMessage.ts';import {readableCodexMarkdown} from '../src/codexMarkup.ts';import {presentUserMessage} from '../src/userMessage.ts';
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const answer='新增[合成作品](https://example.invalid/article)，说明已经完成。\n\n保留普通正文、**排版**和链接。';
const wire=(decision='NOTIFY',message='合成通知摘要。')=>`<heartbeat>\n<automation_id>synthetic-footer</automation_id>\n<decision>${decision}</decision>\n<message>${message}</message>\n</heartbeat>`;
const citation='<oai-mem-citation>\n<citation_entries>synthetic-private-footer</citation_entries>\n<rollout_ids>synthetic-private-id</rollout_ids>\n</oai-mem-citation>';
const vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});after(()=>vite.close());
const {default:Message}=await vite.ssrLoadModule('/src/ConversationMessage.tsx');
const render=(text,role='assistant')=>renderToStaticMarkup(createElement(Message,{threadId:id,message:{id:'same-result',role,text,phase:'final',timestamp:Date.UTC(2026,10,8)}}));

test('complete result footers following authored answers become metadata, with citation framing variants',()=>{
 for(const decision of ['NOTIFY','DONT_NOTIFY'])for(const tail of ['', '\n'+citation,'\n\n'+citation,'\n'+citation.replaceAll('<','&lt;').replaceAll('>','&gt;'),'\n'+citation.split('</citation_entries>')[0]]){
  const source=answer+'\n\n'+wire(decision)+tail, readable=answer+'\n\n合成通知摘要。';
  assert.equal(readableHeartbeatResultSuffix(source),readable);assert.equal(readableHeartbeatMessage(source),readable);assert.equal(readableCodexMarkdown(source),readable);
  const html=render(source);assert.match(html,/example.invalid\/article/);assert.match(html,/<strong>排版<\/strong>/);
  assert.doesNotMatch(html,/&lt;heartbeat|automation_id|synthetic-footer|synthetic-private-footer/);
  assert.match(html,/data-message-id="same-result"/);
 }
});

test('footer rendering is idempotent and preserves original identity, role, raw content and user presentation',()=>{
 const source=answer+'\n\n'+wire()+'\n'+citation;const message={id:'original-id',role:'assistant',text:source};const before=JSON.stringify(message);
 assert.equal(readableHeartbeatResultSuffix(readableHeartbeatResultSuffix(source)),answer+'\n\n合成通知摘要。');render(message.text);assert.equal(JSON.stringify(message),before);
 assert.equal(presentUserMessage(source).copyText,source);assert.equal(presentUserMessage(source).automationInstructions,undefined);assert.match(render(source,'user'),/&lt;heartbeat/);
});

test('code, quoted or introduced format examples never acquire footer semantics',()=>{
 const literal=wire();const samples=[`格式示例：\n\n${literal}`,`Example:\n\n${literal}`,`\`\`\`xml\n${literal}\n\`\`\``, `    ${literal.replaceAll('\n','\n    ')}`,
  literal.split('\n').map(line=>'> '+line).join('\n'),'- Format\n\n'+literal.split('\n').map(line=>'  '+line).join('\n'),`Literal \`${literal.replaceAll('\n',' ')}\``,answer+'\n\n\\'+literal,answer+'\n\n<div>\n'+literal+'\n</div>'];
 for(const source of samples){assert.equal(readableHeartbeatResultSuffix(source),source);assert.equal(projectStructuredMessage(source),null);}
 const source='代码保留：\n\n```xml\n'+literal+'\n```\n\n普通结论。\n\n'+wire()+'\n'+citation;
 const projected=readableHeartbeatResultSuffix(source);assert.match(projected,/```xml\n<heartbeat>/);assert.doesNotMatch(projected,/synthetic-private-footer/);assert.match(render(source),/&lt;heartbeat/);
});

test('unknown, repeated, incomplete, trigger or nonterminal metadata remains visible and inert',()=>{
 const malformed=[wire('FUTURE'),wire().replace('<automation_id>synthetic-footer</automation_id>',''),wire().replace('<message>','<unknown>x</unknown><message>'),wire().replace('</message>','</message><message>duplicate</message>'),wire().replace('</heartbeat>',''),wire().replace('<heartbeat>','<heartbeat version="future">'),'<heartbeat><automation_id>synthetic-footer</automation_id><instructions>Keep the synthetic request</instructions></heartbeat>',wire()+'\n\nAuthored continuation.'];
 for(const suffix of malformed){const source=answer+'\n\n'+suffix;assert.equal(readableHeartbeatResultSuffix(source),source);const html=render(source);assert.match(html,/&lt;heartbeat/);assert.doesNotMatch(html,/<heartbeat\b|<script\b/);}
 const repeated=answer+'\n\n'+wire()+'\n\n'+wire();assert.equal(readableHeartbeatResultSuffix(repeated),repeated);
 assert.equal(readableHeartbeatResultSuffix(wire()),wire());
});

test('wire field code and Markdown examples remain protected while a complete metadata footer is accepted',()=>{
 const field='Literal closing code `</message>` stays in its field.\n\n```xml\n</heartbeat>\n</message>\n```';
 assert.equal(readableHeartbeatResultSuffix(answer+'\n\n'+wire('NOTIFY',field)+'\n'+citation),answer+'\n\n'+field);
 assert.equal(readableHeartbeatResultSuffix(answer+'\n\n'+wire()+'\n```xml\n'+citation+'\n```'),answer+'\n\n'+wire()+'\n```xml\n'+citation+'\n```');
});

test("unique result messages remain readable and only exact visible paragraph text is deduplicated",()=>{
 const message="合成 通知 摘要。";const prefix=answer+"\n\n**合成  通知**\n摘要。";
 assert.equal(readableHeartbeatResultSuffix(prefix+"\n\n"+wire("NOTIFY",message)),prefix);
 const withOnlyDestination=answer+"\n\n[引用](https://example.invalid/"+encodeURIComponent(message)+")";
 assert.equal(readableHeartbeatResultSuffix(withOnlyDestination+"\n\n"+wire("NOTIFY",message)),withOnlyDestination+"\n\n"+message);
 const partlyMentioned=answer+"\n\n前缀 "+message+" 后续仍有正文。";
 assert.equal(readableHeartbeatResultSuffix(partlyMentioned+"\n\n"+wire("NOTIFY",message)),partlyMentioned+"\n\n"+message);
 assert.match(render(answer+"\n\n"+wire("NOTIFY","合成独有结果必须保留。")),/合成独有结果必须保留/);
});

test('result links, images and components are never lost through text-only deduplication',()=>{
 const plain='检查已完成。';
 for(const body of [plain+'![独有结果图](/synthetic-result.png)',plain+'[证明](https://example.invalid/proof)',plain+'<details><summary>详情</summary>独有结果</details>']){
  const source=plain+'\n\n'+wire('NOTIFY',body);const result=readableHeartbeatResultSuffix(source);assert.notEqual(result,plain);assert.match(result,/synthetic-result|example.invalid\/proof|独有结果/);
 }
 const source='[证明](https://example.invalid/old)\n\n'+wire('NOTIFY','[证明](https://example.invalid/new)');
 const projected=readableHeartbeatResultSuffix(source);assert.match(projected,/\/old/);assert.match(projected,/\/new/);
});

test('single-line and multiline result footers have the same readable projection',()=>{
 const multiline=wire('NOTIFY','独有单行状态。'),single=multiline.replaceAll('\n','');
 for(const footer of [multiline,single]){
  const source=answer+'\n\n'+footer+'\n'+citation;
  assert.equal(readableHeartbeatResultSuffix(source),answer+'\n\n独有单行状态。');
  const html=render(source);assert.match(html,/<p>独有单行状态。<\/p>/);assert.doesNotMatch(html,/&lt;heartbeat|automation_id|NOTIFY/);
 }
 const introduced='Format example:\n\n'+single;assert.equal(readableHeartbeatResultSuffix(introduced),introduced);
 const inline='Inline '+single;assert.equal(readableHeartbeatResultSuffix(inline),inline);
});
