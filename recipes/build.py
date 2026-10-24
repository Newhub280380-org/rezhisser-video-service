import yaml
class LS(str):pass
yaml.SafeDumper.add_representer(LS,lambda d,v:d.represent_scalar('tag:yaml.org,2002:str',v,style='|'))
import re,os,json,glob,hashlib,yaml,collections,difflib,sys
# Regenerates recipes/*.yaml, catalog.json, router.md, tools.md and duplicates.md
# next to this script. Source is a directory of NNN_*.md write-ups.
#   python3 build.py /path/to/markdown-sources
ROOT=os.path.dirname(os.path.abspath(__file__))
SRC=sys.argv[1] if len(sys.argv)>1 else os.environ.get('RECIPE_SOURCE','')
OUT=ROOT
if not SRC or not os.path.isdir(SRC):
    raise SystemExit('usage: python3 build.py <dir-with-NNN_*.md>')
TOOLS={'Seedance':r'seedance','Kling':r'kling|клинг','MiniMax H3':r'minimax|hailuo|\bh3\b','SAM3':r'sam ?3','Wan':r'\bwan\b','Veo':r'\bveo','Sora':r'\bsora','Higgsfield':r'higgsfield','Nano Banana':r'nano ?banana','GPT Image':r'gpt[- ]?image|chatgpt|gpt-4o','Midjourney':r'midjourney','Flux':r'\bflux','Qwen':r'qwen','ElevenLabs':r'elevenlabs','Runway':r'runway','ComfyUI':r'comfy','Hedra':r'hedra','HeyGen':r'heygen','Pika':r'\bpika','Luma':r'\bluma|ray ?[23]','Topaz':r'topaz','CapCut':r'capcut','Suno':r'\bsuno','Seedream':r'seedream','Grok Imagine':r'grok','LTX':r'\bltx','Vidu':r'\bvidu','PixVerse':r'pixverse','Gemini':r'gemini','Freepik':r'freepik','Krea':r'\bkrea','Photoshop':r'photoshop','Premiere/DaVinci':r'premiere|davinci','Ideogram':r'ideogram','Recraft':r'recraft','Magnific':r'magnific','Hunyuan':r'hunyuan','OmniHuman':r'omnihuman'}
TAGS={'product_ad':r'товар|продукт|бренд|реклам|product|упаковк|бутыл|карточк|ugc','beauty_ad':r'косметик|beauty|крем|помад|макияж|духи|парфюм|кож[аи]|косметолог','talking_head':r'говорящ|talking|липсинк|lip.?sync|речь|диалог|озвуч|голос|ugc','client_in_clip':r'своему фото|своё фото|по фото|фото клиента|фото человека|себя|селфи|подмен|замен|swap|recast|герой с фото|фото героя|ваше фото','seamless_series':r'бесшов|seamless|последн\w* кадр|last frame|one.?take|длинн|склей|переход|transition|цепоч','meme':r'\\bмем|meme|вирусн|viral|тренд|смешн|приколь','pov_one_take':r'\bpov\b|one.?take|одним дублем|от первого лица|пролёт|fpv|полёт','animal':r'питом|собак|кошк|\bкот|животн|pet|dog|cat\b','object_alive':r'оживл|оживить|говорящий предмет|animate','vfx_effect':r'эффект|vfx|трансформ|взрыв|морф','family_photos':r'семь|n фото|несколько фото|разных местах|реставрац|старое фото','dance':r'танц|\\bdance|хореограф','motion_transfer':r'motion control|перенос движ|v2v|видео-референс|reference video'}
def sec(md,name):
    m=re.search(r'^##\s*'+name+r'[^\n]*\n(.*?)(?=^##\s|\Z)',md,re.M|re.S); return m.group(1) if m else ''
def find(md,pat):
    m=re.search(pat,md,re.I|re.M); return m.group(1).strip() if m else None
def tools_in(t): return [k for k,p in TOOLS.items() if re.search(p,t,re.I)]
recs=[]
files=sorted([f for f in glob.glob(SRC+'/*.md') if re.match(r'\d+_',os.path.basename(f))],key=lambda f:int(os.path.basename(f).split('_')[0]))
for f in files:
    md=open(f).read(); base=os.path.basename(f)[:-3]; num=int(base.split('_')[0]); slug=base.split('_',1)[1]
    title=re.sub(r'^#\s*\d+\.\s*','',md.splitlines()[0]).strip()
    conf=find(md,r'надёжность[:*\s]*\**\s*:?\s*\**\s*([ABC](?:/[ABC])?)') or 'unknown'
    what=sec(md,'Что делает').strip()
    steps_txt=sec(md,'Шаги')
    blocks=[(m.start(),m.group(1).strip()) for m in re.finditer(r'```[a-z]*\n(.*?)```',md,re.S)]
    stepstart=md.find(steps_txt) if steps_txt else -1
    steps=[]
    if steps_txt:
        items=re.split(r'\n(?=\d+\.\s)',steps_txt.strip())
        for it in items:
            if not re.match(r'\d+\.',it): 
                if steps: steps[-1]['_raw']+= '\n'+it
                continue
            steps.append({'_raw':it})
    out_steps=[]; used=set()
    for i,s in enumerate(steps):
        raw=s['_raw']; inl=re.findall(r'```[a-z]*\n(.*?)```',raw,re.S)
        txt=re.sub(r'```.*?```','[PROMPT]',raw,flags=re.S)
        txt=re.sub(r'^\d+\.\s*','',txt).strip()
        prompts=[LS(p.strip()) for p in inl]
        q=re.findall(r'"([^"]{60,})"',txt)  # inline quoted prompts
        for p in prompts: used.add(hashlib.md5(p.encode()).hexdigest())
        tl=tools_in(txt)
        dur=find(txt,r'(\d+(?:[–-]\d+)?\s*(?:с|сек|s)\b)'); asp=find(txt,r'(\d{1,2}:\d{1,2})')
        mode=find(txt,r'(image[- ]to[- ]video|text[- ]to[- ]video|ref[- ]to[- ]video|i2v|t2v|v2v|motion control|keyframes|first[/ ]last frame|start.?end frame|первому/последнему кадру|omni|lip.?sync|липсинк|multi.?ref\w*)')
        src='last_frame' if re.search(r'последн\w* кадр|last frame|финальн\w* кадр',txt,re.I) else ('previous_step_output' if i>0 and re.search(r'получ|результат|из шага|предыдущ|затем|потом',txt,re.I) else ('user_input' if i==0 else 'unknown'))
        out_steps.append({'n':i+1,'action':txt,'tool':tl or 'unknown','mode':mode or 'unknown','prompt':(prompts if prompts else (q if q else 'unknown')),'input_source':src,'duration':dur or 'unknown','aspect':asp or 'unknown'})
    pass
    extra=[b for p,b in blocks if hashlib.md5(b.encode()).hexdigest() not in used]
    for s_ in out_steps:
        if s_['prompt']=='unknown' and extra and re.search(r'промпт|prompt',s_['action'],re.I):
            s_['prompt']='see prompts_verbatim (verbatim block(s) below, from source)'
    if not out_steps:
        out_steps=[{'n':1,'action':'unknown (в источнике нет нумерованных шагов; см. prompts_verbatim)','tool':tools_in(md) or 'unknown','mode':'unknown','prompt':'unknown','input_source':'unknown','duration':'unknown','aspect':'unknown'}]
    low=(title+' '+what+' '+steps_txt[:3000]).lower()
    tags=[t for t,p in TAGS.items() if re.search(p,low,re.I)] or ['other']
    inputs=[]
    for k,p in [('фото товара/продукта',r'фото товар|фото продукт|product photo|фото бутыл|карточк'),('фото лица/портрет человека',r'фото (лица|человека|героя|клиента)|селфи|портрет|лицо открыто'),('фото в полный рост',r'в рост|full.?body'),('видео-референс (движение/клип)',r'видео-референс|video 1|reference video|референс-видео|клип-образец|исходн\w* видео'),('стартовый кадр',r'стартов\w* кадр|first frame|start frame|первый кадр'),('финальный кадр',r'финальн\w* кадр|end frame|последний кадр'),('аудио/голос',r'аудио|audio|голос|озвуч'),('фото питомца',r'фото (питомца|собаки|кота|кошки)'),('старое фото',r'старое фото|старых фото|old photo'),('логотип',r'логотип|logo'),('фото локации/города',r'фото (города|локации|места|комнаты|дома)')]:
        if re.search(p,md,re.I): inputs.append(k)
    nprom=sum(isinstance(s['prompt'],list) for s in out_steps)
    completeness='complete' if (blocks and all((s['prompt']!='unknown') or not re.search(r'промпт|prompt|\[PROMPT\]',s['action'],re.I) for s in out_steps) and steps_txt) else ('partial' if blocks else 'gaps')
    res=find(md,r'(\b(?:480|720|1080|2160)p\b|\b4K\b)')
    r={'id':f'{num:03d}_{slug}','source_file':os.path.basename(f),'title':title,'intent_tags':tags,
       'use_when':(re.sub(r'\s+',' ',what)[:300] if what else title),
       'inputs':inputs or ['unknown'],'steps':out_steps,
       'prompts_verbatim':[LS(x) for x in extra],
       'output':{'format':'mp4' if re.search(r'видео|video|ролик|kling|seedance|h3|veo|wan',md,re.I) else 'unknown','resolution':res or 'unknown','aspect':find(md,r'\b(9:16|16:9|1:1|4:5)\b') or 'unknown'},
       'done_criteria':re.sub(r'\s+',' ',sec(md,'Что даёт')).strip()[:500] or 'unknown',
       'confidence':conf,'prompt_completeness':completeness,
       'notes':re.sub(r'\s+',' ',sec(md,'Закрыто')).strip()[:500] or (find(md,r'\*\*Что закрыто:\*\*\s*(.*)') or ''),
       'source_url':find(md,r'(https?://\S+)')}
    recs.append(r)
# duplicates: same verbatim prompt or similar titles
dups=[]; ph=collections.defaultdict(list)
for r in recs:
    for b in r['prompts_verbatim']+[p for s in r['steps'] if isinstance(s['prompt'],list) for p in s['prompt']]:
        if len(b)>150: ph[hashlib.md5(re.sub(r'\s+',' ',b).encode()).hexdigest()].append(r['id'])
for h,ids in ph.items():
    ids=sorted(set(ids))
    if len(ids)>1: dups.append((ids,'идентичный дословный промпт'))
for i,a in enumerate(recs):
    for b in recs[i+1:]:
        if difflib.SequenceMatcher(None,a['title'].lower(),b['title'].lower()).ratio()>0.72: dups.append(([a['id'],b['id']],'почти одинаковое название'))
def tk(r): return set(w for w in r['id'].split('_')[1:] if len(w)>2)
for i,a in enumerate(recs):
    for b in recs[i+1:]:
        A,B=tk(a),tk(b)
        if A and B and len(A&B)/len(A|B)>=0.5: dups.append(([a['id'],b['id']],'почти одинаковый набор приёмов в slug: '+','.join(sorted(A&B))))
        elif a['source_url'] and a['source_url']==b['source_url']: dups.append(([a['id'],b['id']],'один и тот же источник (URL)'))
seen=set(); D=[]
for ids,why in dups:
    k=tuple(ids)
    if k not in seen: seen.add(k); D.append((ids,why))
dmap=collections.defaultdict(set)
for ids,_ in D:
    for x in ids: dmap[x]|=set(ids)-{x}
for r in recs:
    r['duplicates_of']=sorted(dmap.get(r['id'],[]))
    yaml.safe_dump(r,open(f"{OUT}/recipes/{r['id']}.yaml",'w'),allow_unicode=True,sort_keys=False,width=200)
json.dump([{k:r[k] for k in ('id','title','intent_tags','use_when','inputs','confidence','prompt_completeness','duplicates_of')} for r in recs],open(OUT+'/catalog.json','w'),ensure_ascii=False,indent=1)
with open(OUT+'/duplicates.md','w') as o:
    o.write('# Дубликаты / близкие варианты\nОба файла сохранены, в YAML поле duplicates_of ссылается на пару.\n\n')
    for ids,why in D: o.write(f"- {' ↔ '.join(ids)} — {why}\n")
tu=collections.defaultdict(set)
for r in recs:
    for s in r['steps']:
        if isinstance(s['tool'],list):
            for t in s['tool']: tu[t].add(r['id'])
    for t in tools_in(r['title']+' '.join(r['prompts_verbatim'])): tu[t].add(r['id'])
with open(OUT+'/tools.md','w') as o:
    o.write('# Инструменты по рецептам\n(выделены по ключевым словам из шагов/заголовков источника)\n\n')
    for t,ids in sorted(tu.items(),key=lambda x:-len(x[1])): o.write(f"## {t} — {len(ids)}\n"+', '.join(sorted(ids))+'\n\n')
tc=collections.Counter(t for r in recs for t in r['intent_tags'])
# reusability score
def score(r):
    return {'complete':3,'partial':1.5,'gaps':0}[r['prompt_completeness']]+len(r['intent_tags'])*0.5+(1 if r['confidence'].startswith('B') else 0)+ (1 if 'unknown' not in r['inputs'] else 0) + 0.3*len([s for s in r['steps'] if s['tool']!='unknown'])
top=sorted(recs,key=score,reverse=True)[:10]
with open(OUT+'/router.md','w') as o:
    o.write('# Роутер режиссёра: как выбрать рецепт по запросу\n\n## Алгоритм\n1. Определи интент запроса → теги (таблица ниже).\n2. Определи, что прислал клиент (inputs): фото товара, фото лица, фото в рост, видео-референс, старт/финал кадры, аудио.\n3. Отфильтруй catalog.json: все теги запроса ⊂ intent_tags, inputs рецепта ⊆ доступным файлам.\n4. Ранжируй: prompt_completeness complete > partial > gaps; confidence B > B/C > C; меньше шагов с tool=unknown.\n5. Если в рецепте есть шаг/промпт `unknown` — не выдумывай: возьми близкий рецепт (duplicates_of) или спроси у клиента недостающий файл.\n6. Подставь данные клиента в промпт только в явных местах (Image 1, @Image1, [product] и т.п.); остальной текст промпта не менять.\n\n## Таблица интентов\n| Тег | Признаки в запросе | Обязательные inputs | Рецептов | Лучшие (по полноте) |\n|---|---|---|---|---|\n')
    hints={'product_ad':('«реклама товара», «ролик для карточки», «UGC»','фото товара'),'beauty_ad':('косметика, духи, крем, уход','фото товара (+лицо)'),'talking_head':('«чтобы говорил», озвучка, липсинк','фото лица + текст/аудио'),'client_in_clip':('«вставь меня», «по моему фото», подмена героя','фото лица/в рост (+видео-референс)'),'seamless_series':('длинный бесшовный ролик, переходы, серия','старт/финал кадры или цепочка last frame'),'meme':('вирусный тренд, мем, смешное','видео-образец тренда или фото'),'pov_one_take':('POV, одним дублем, пролёт','фото локации/героя'),'animal':('питомец, кот, собака','фото питомца'),'object_alive':('оживить предмет/фото','фото объекта'),'vfx_effect':('эффект, трансформация','фото/кадр'),'family_photos':('семья, старые фото, реставрация','несколько/старые фото'),'dance':('танец, хореография','видео-референс танца + фото'),'motion_transfer':('повторить движение из видео','видео-референс + фото персонажа'),'other':('прочее','—')}
    for t,c in tc.most_common():
        best=[r['id'] for r in sorted([r for r in recs if t in r['intent_tags']],key=score,reverse=True)[:4]]
        h=hints.get(t,('',''))
        o.write(f"| {t} | {h[0]} | {h[1]} | {c} | {', '.join(best)} |\n")
    o.write('\n## Таблица по входным файлам\n| Что прислал клиент | Рецепты (топ-5) |\n|---|---|\n')
    ic=collections.defaultdict(list)
    for r in recs:
        for i in r['inputs']: ic[i].append(r)
    for i,rs in sorted(ic.items(),key=lambda x:-len(x[1])):
        o.write(f"| {i} ({len(rs)}) | {', '.join(x['id'] for x in sorted(rs,key=score,reverse=True)[:5])} |\n")
    o.write('\n## Топ-10 универсальных рецептов\n'+''.join(f"- {r['id']} — {r['title']}\n" for r in top))
print(len(recs),len(D),tc.most_common(),collections.Counter(r['prompt_completeness'] for r in recs),collections.Counter(r['confidence'] for r in recs),len(tu))
print(sum(1 for r in recs for s in r['steps'] if s['prompt']=='unknown' and '[PROMPT]' not in s['action']))
for r in top: print(r['id'],'|',r['title'][:90])
