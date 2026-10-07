"""Generate editable BPMN 2.0 collaborations and SVG previews from one model."""
from pathlib import Path
import copy
import html
import json
import textwrap
import xml.etree.ElementTree as E
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'bpmn'
OUT.mkdir(parents=True, exist_ok=True)
NS = {'bpmn':'http://www.omg.org/spec/BPMN/20100524/MODEL',
      'bpmndi':'http://www.omg.org/spec/BPMN/20100524/DI',
      'dc':'http://www.omg.org/spec/DD/20100524/DC',
      'di':'http://www.omg.org/spec/DD/20100524/DI'}
for k,v in NS.items(): E.register_namespace(k,v)
def el(parent, tag, **attrs):
    prefix, name = tag.split(':')
    return E.SubElement(parent, '{'+NS[prefix]+'}'+name, {k:str(v) for k,v in attrs.items()})
def txt(parent, tag, value):
    e = el(parent,tag); e.text=value
    if tag in ('bpmn:incoming','bpmn:outgoing'):
        parent.remove(e)
        children=list(parent)
        # flowNode references precede event definitions in the BPMN XML sequence.
        rank={'documentation':0,'extensionElements':1,'incoming':2,'outgoing':3}
        wanted=rank[tag.split(':')[1]]
        index=next((i for i,c in enumerate(children) if rank.get(c.tag.split('}')[-1],9)>wanted),len(children))
        parent.insert(index,e)
    return e

class Model:
    def __init__(self, key, title, width, height):
        self.key,self.title,self.width,self.height=key,title,width,height
        self.root=E.Element('{'+NS['bpmn']+'}definitions', {'id':key+'_Definitions', 'targetNamespace':'https://copiloto-financeiro.local/bpmn', 'exporter':'Copiloto Financeiro', 'exporterVersion':'1.0'})
        self.coll=el(self.root,'bpmn:collaboration',id=self.id('Collaboration'),name=title)
        self.procs={};self.items={};self.shapes=[];self.edges=[];self.count=0
        self.diag=el(self.root,'bpmndi:BPMNDiagram',id=self.id('Diagram'),name=title)
        self.plane=el(self.diag,'bpmndi:BPMNPlane',id=self.id('Plane'),bpmnElement=self.id('Collaboration'))
    def id(self,s): return self.key+'_'+s
    def pool(self, key, name, y, h, expanded=True):
        if expanded:
            p=el(self.root,'bpmn:process',id=self.id('Process_'+key),name=name,isExecutable='false')
            self.procs[key]=p
        attrs={'id':self.id('Pool_'+key),'name':name}
        if expanded: attrs['processRef']=self.id('Process_'+key)
        elem=el(self.coll,'bpmn:participant',**attrs)
        self.items[key]=(elem,(60,y,self.width-100,h),'participant',None)
        self.shape(key,expanded=expanded)
    def node(self, pool, key, name, kind, x, y, w=None, h=None, event=None, doc=None):
        if kind=='subProcess':
            kind='serviceTask'
            doc=(doc+'\n' if doc else '')+'Atividade agregada para visão de negócio; detalhes internos foram condensados neste modelo não executável.'
        if w is None: w=46 if 'Gateway' in kind else 36 if 'Event' in kind else 170
        if h is None: h=w if ('Gateway' in kind or 'Event' in kind) else 84
        elem=el(self.procs[pool],'bpmn:'+kind,id=self.id(key),name=name)
        if doc: txt(elem,'bpmn:documentation',doc)
        if event: el(elem,'bpmn:'+event+'EventDefinition',id=self.id(key+'_EventDef'))
        if kind=='eventBasedGateway': elem.set('eventGatewayType','Exclusive');elem.set('instantiate','false')
        self.items[key]=(elem,(x,y,w,h),kind,pool)
        self.shape(key)
        return key
    def shape(self,key,expanded=False):
        elem,b,kind,pool=self.items[key]
        attrs={'id':elem.get('id')+'_di','bpmnElement':elem.get('id')}
        if kind=='participant': attrs['isHorizontal']='true'
        if kind=='subProcess': attrs['isExpanded']='false'
        shape=el(self.plane,'bpmndi:BPMNShape',**attrs)
        el(shape,'dc:Bounds',x=b[0],y=b[1],width=b[2],height=b[3])
        if 'Event' in kind or 'Gateway' in kind or kind=='dataStoreReference':
            label=el(shape,'bpmndi:BPMNLabel')
            el(label,'dc:Bounds',x=b[0]-55,y=b[1]+b[3]+5,width=b[2]+110,height=48)
        self.shapes.append((key,expanded))
    def port(self,key,side):
        x,y,w,h=self.items[key][1]
        return {'l':(x,y+h/2),'r':(x+w,y+h/2),'t':(x+w/2,y),'b':(x+w/2,y+h)}[side]
    def edge(self,a,b,name='',kind='sequenceFlow',points=None,sides=('r','l'),doc=None):
        self.count+=1;key=self.id('Flow_'+str(self.count))
        ea,ba,ka,pa=self.items[a];eb,bb,kb,pb=self.items[b]
        parent=self.coll if kind=='messageFlow' else self.procs[pa or pb]
        attrs={'id':key,'sourceRef':ea.get('id'),'targetRef':eb.get('id')}
        if name: attrs['name']=name
        if kind=='association': attrs['associationDirection']='One'
        e=el(parent,'bpmn:'+kind,**attrs)
        if doc: txt(e,'bpmn:documentation',doc)
        if kind=='sequenceFlow':
            assert pa==pb, (a,b,'sequence flow crosses pools')
            txt(ea,'bpmn:outgoing',key);txt(eb,'bpmn:incoming',key)
        if points is None:
            start,end=self.port(a,sides[0]),self.port(b,sides[1])
            points=[start,end] if start[0]==end[0] or start[1]==end[1] else [start,((start[0]+end[0])/2,start[1]),((start[0]+end[0])/2,end[1]),end]
        ed=el(self.plane,'bpmndi:BPMNEdge',id=key+'_di',bpmnElement=key)
        for x,y in points: el(ed,'di:waypoint',x=x,y=y)
        if name:
            # Place label over the longest segment.
            s,t=max(zip(points,points[1:]),key=lambda p:abs(p[1][0]-p[0][0])+abs(p[1][1]-p[0][1]))
            lx,ly=(s[0]+t[0])/2,(s[1]+t[1])/2
            lab=el(ed,'bpmndi:BPMNLabel');el(lab,'dc:Bounds',x=lx-90,y=ly-36,width=180,height=32)
        self.edges.append((kind,points,name))
    def chain(self,*keys):
        for a,b in zip(keys,keys[1:]): self.edge(a,b)
    def msg(self,a,b,name='',**kw):
        # Preserve technical names in documentation; short connectors and
        # vertical messages remain legible without duplicate external labels.
        self.edge(a,b,name if 'cnpj' in (a,b) else '', 'messageFlow',doc=name,**kw)
    def note(self,pool,key,text,x,y,w=380,h=90,target=None):
        e=el(self.procs[pool],'bpmn:textAnnotation',id=self.id(key));txt(e,'bpmn:text',text)
        self.items[key]=(e,(x,y,w,h),'textAnnotation',pool);self.shape(key)
        if target: self.edge(key,target,kind='association',sides=('l','b'))
    def store(self,pool,key,x,y):
        ds=el(self.root,'bpmn:dataStore',id=self.id('PostgresStore'),name='Postgres',isUnlimited='true')
        e=el(self.procs[pool],'bpmn:dataStoreReference',id=self.id(key),name='Postgres',dataStoreRef=ds.get('id'))
        self.items[key]=(e,(x,y,70,70),'dataStoreReference',pool);self.shape(key)
    def http(self,pool,send,gateway,ok,error,end,x,y):
        self.node(pool,gateway,'Aguardar resposta','eventBasedGateway',x,y+19)
        self.node(pool,ok,'Resposta de sucesso','intermediateCatchEvent',x+140,y+24,event='message')
        self.node(pool,error,'Resposta de erro','intermediateCatchEvent',x+140,y+175,event='message')
        self.node(pool,end,'Chamada sem sucesso','endEvent',x+310,y+175)
        self.chain(send,gateway);self.edge(gateway,ok);self.edge(gateway,error,sides=('b','l'));self.chain(error,end)
    def write(self,filename):
        self.root.remove(self.diag);self.root.append(self.diag)
        E.indent(self.root)
        E.ElementTree(self.root).write(OUT/filename,encoding='utf-8',xml_declaration=True)
        self.svg(OUT/filename.replace('.bpmn','.svg'))
    def svg(self,path):
        def esc(s):return html.escape(s)
        s=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}">',
           '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#405469"/></marker><marker id="open" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="#405469"/></marker></defs>',
           '<rect width="100%" height="100%" fill="#fff"/>',f'<text x="60" y="45" font-family="Arial" font-size="23" font-weight="bold" fill="#132f49">{esc(self.title)}</text>',
           '<text x="60" y="73" font-family="Arial" font-size="13" fill="#5b6f80">Copiloto Financeiro · 06/10/2026 · Visão de negócio · BPMN 2.0</text>']
        def text(label,x,y,width,size=13,align='middle'):
            lines=[]
            for p in label.split('\n'): lines.extend(textwrap.wrap(p,max(9,int(width/(size*.53)))) or [''])
            for i,line in enumerate(lines):s.append(f'<text x="{x}" y="{y+i*(size+3)}" text-anchor="{align}" font-family="Arial" font-size="{size}" fill="#172d40">{esc(line)}</text>')
        for key,expanded in self.shapes:
            e,(x,y,w,h),kind,p=self.items[key]
            if kind!='participant':continue
            fill={'n':'#f2f8ff','b':'#f3faf6','u':'#fff9ee','e':'#f6f3fa','cnpj':'#f9f3ff'}.get(key,'#f8fafc')
            s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="#8798a8"/>')
            s.append(f'<path d="M{x+38} {y}V{y+h}" stroke="#8798a8"/>')
            s.append(f'<text transform="translate({x+25} {y+h/2}) rotate(-90)" text-anchor="middle" font-family="Arial" font-size="16" font-weight="bold" fill="#233d53">{esc(e.get("name"))}</text>')
        for kind,points,name in self.edges:
            pts=' '.join(f'{x},{y}' for x,y in points)
            dashed=' stroke-dasharray="8 6"' if kind=='messageFlow' else ' stroke-dasharray="3 5"' if kind=='association' else ''
            s.append(f'<polyline points="{pts}" fill="none" stroke="#405469" stroke-width="1.5"{dashed} marker-end="url(#{"arrow" if kind=="sequenceFlow" else "open"})"/>')
            if kind=='messageFlow':s.append(f'<circle cx="{points[0][0]}" cy="{points[0][1]}" r="3" fill="white" stroke="#405469"/>')
            if name:
                a,b=max(zip(points,points[1:]),key=lambda p:abs(p[1][0]-p[0][0])+abs(p[1][1]-p[0][1]))
                text(name,(a[0]+b[0])/2,(a[1]+b[1])/2-20,165,11)
        for key,_ in self.shapes:
            e,(x,y,w,h),kind,p=self.items[key];name=e.get('name','')
            if kind=='participant':continue
            if kind=='textAnnotation':
                s.append(f'<path d="M{x+12} {y}H{x}V{y+h}H{x+12}" fill="none" stroke="#6c7e8d"/>');text(e.find('bpmn:text',NS).text,x+12,y+17,w-20,12,'start');continue
            if kind=='dataStoreReference':
                s.append(f'<path d="M{x} {y+12}V{y+h-12}C{x} {y+h+4} {x+w} {y+h+4} {x+w} {y+h-12}V{y+12}" fill="white" stroke="#32634b" stroke-width="2"/><ellipse cx="{x+w/2}" cy="{y+12}" rx="{w/2}" ry="12" fill="white" stroke="#32634b" stroke-width="2"/>');text(name,x+w/2,y+h+20,160);continue
            if 'Gateway' in kind:
                s.append(f'<path d="M{x+w/2} {y}L{x+w} {y+h/2}L{x+w/2} {y+h}L{x} {y+h/2}Z" fill="white" stroke="#405469" stroke-width="2"/>')
                if kind=='eventBasedGateway':
                    s.append(f'<circle cx="{x+w/2}" cy="{y+h/2}" r="13" fill="none" stroke="#405469"/><circle cx="{x+w/2}" cy="{y+h/2}" r="10" fill="none" stroke="#405469"/><path d="M{x+23} {y+14}L{x+32} {y+21}L{x+28} {y+31}H{x+18}L{x+14} {y+21}Z" fill="none" stroke="#405469"/>')
                else:text('×',x+w/2,y+32,40,27)
                text(name,x+w/2,y+h+19,145,12);continue
            if 'Event' in kind:
                stroke=4 if kind=='endEvent' else 2
                s.append(f'<circle cx="{x+w/2}" cy="{y+h/2}" r="{w/2-2}" fill="white" stroke="#405469" stroke-width="{stroke}"/>')
                if kind=='intermediateCatchEvent':s.append(f'<circle cx="{x+w/2}" cy="{y+h/2}" r="{w/2-6}" fill="none" stroke="#405469"/>')
                if e.find('bpmn:messageEventDefinition',NS) is not None:
                    s.append(f'<rect x="{x+8}" y="{y+11}" width="20" height="14" fill="none" stroke="#405469"/><path d="M{x+8} {y+11}L{x+18} {y+20}L{x+28} {y+11}" fill="none" stroke="#405469"/>')
                if e.find('bpmn:timerEventDefinition',NS) is not None:
                    s.append(f'<circle cx="{x+18}" cy="{y+18}" r="10" fill="none" stroke="#405469"/><path d="M{x+18} {y+10}V{y+18}L{x+24} {y+21}" fill="none" stroke="#405469"/>')
                text(name,x+w/2,y+h+20,135,12);continue
            s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="white" stroke="#405469" stroke-width="1.8"/>')
            icon={'sendTask':'✉','serviceTask':'⚙','userTask':'♙','subProcess':'+'}.get(kind,'')
            if kind=='subProcess':
                s.append(f'<rect x="{x+w/2-8}" y="{y+h-20}" width="16" height="16" fill="white" stroke="#405469"/>');text('+',x+w/2,y+h-7,20,15)
            elif icon:text(icon,x+17,y+19,25,15)
            lines=sum(max(1,len(textwrap.wrap(z,max(9,int((w-20)/(13*.53)))))) for z in name.split('\n'))
            text(name,x+w/2,y+h/2-(lines-1)*8+3,w-20)
        s.append('</svg>');path.write_text('\n'.join(s),encoding='utf-8')

def classify():
    m=Model('Review','As Is · 1. Revisão de classificações pelo WhatsApp',2850,1840)
    m.pool('u','Usuário',110,155);m.pool('e','Evolution',290,70,False);m.pool('n','n8n',390,520);m.pool('b','Backend',950,830)
    m.node('u','UserStart','Sugestão recebida','startEvent',1850,151,event='message')
    m.node('u','UserDecision','Aceitar ou corrigir categoria; escolher se vira regra','userTask',1940,128,w=210)
    m.node('u','UserReply','Responder à mensagem citada','sendTask',2220,128)
    m.node('u','UserEnd','Resposta enviada','endEvent',2500,151);m.chain('UserStart','UserDecision','UserReply','UserEnd')
    m.node('n','Schedule','Verificação periódica','startEvent',170,433,event='timer')
    m.node('n','Claim','Solicitar próxima revisão (claim next)','sendTask',280,410,doc='POST /classification-reviews/next. O schedule tem frequência configurada no n8n, não legível na print.')
    m.http('n','Claim','WaitClaim','ClaimOk','ClaimError','ClaimFail',535,410)
    m.node('n','Ready','Revisão READY?','exclusiveGateway',845,428)
    m.node('n','NoReview','Sem novo envio','endEvent',1050,433)
    m.chain('Schedule','Claim');m.chain('ClaimOk','Ready');m.edge('Ready','NoReview','Não: EMPTY / ocupada')
    m.node('n','SendSuggestion','Enviar sugestão via Evolution','sendTask',1830,410)
    m.node('n','MessageId','ID da mensagem enviada','intermediateCatchEvent',2070,434,event='message')
    m.node('n','Attach','Vincular ID à revisão no backend','serviceTask',2190,410,doc='PATCH /classification-reviews/:reviewId/message; persiste externalMessageId e marca WAITING_REPLY. Detalhe HTTP condensado nesta atividade.')
    m.node('n','SentEnd','Aguardar webhook em nova execução','endEvent',2490,434)
    m.edge('Ready','SendSuggestion','Sim',points=[m.port('Ready','r'),(985,451),(985,535),(1775,535),(1775,452),m.port('SendSuggestion','l')]);m.chain('SendSuggestion','MessageId','Attach','SentEnd')
    m.node('n','Webhook','Resposta via webhook','startEvent',170,684,event='message')
    m.node('n','Normalize','Normalizar texto ou transcrever áudio','subProcess',280,660)
    m.node('n','BufferTime','Janela de agrupamento','intermediateCatchEvent',520,684,event='timer',doc='Espera do workflow existente para juntar mensagens. Duração não legível na print; não confundir com o lease de 15 minutos da reserva de revisão.')
    m.node('n','Join','Consolidar mensagens','serviceTask',630,660)
    m.node('n','Interpret','Interpretar categoria, regra e quotedMessageId','subProcess',875,660,w=195)
    m.node('n','Reply','Enviar decisão ao backend','sendTask',1140,660,doc='POST /classification-reviews/reply; action ACCEPT_SUGGESTION ou CHANGE_CATEGORY, createMerchantRule e pattern/matchType quando necessário.')
    m.http('n','Reply','WaitReply','ReplyOk','ReplyError','ReplyFail',1370,660)
    m.node('n','Next','Há próxima revisão?','exclusiveGateway',1705,679)
    m.node('n','Done','Fila encerrada / sem nova revisão','endEvent',1880,769)
    m.chain('Webhook','Normalize','BufferTime','Join','Interpret','Reply');m.chain('ReplyOk','Next')
    m.edge('Next','SendSuggestion','Sim: next',sides=('t','l'),points=[m.port('Next','t'),(1728,452),m.port('SendSuggestion','l')])
    m.edge('Next','Done','Não',sides=('b','l'))
    m.msg('SendSuggestion','e','Solicitação de envio',sides=('t','b'),points=[m.port('SendSuggestion','t'),(1915,360)])
    m.msg('e','UserStart','Sugestão',sides=('t','b'),points=[(1868,290),m.port('UserStart','b')])
    m.msg('UserReply','e','Resposta citada',sides=('b','t'),points=[m.port('UserReply','b'),(2305,290)])
    m.msg('e','MessageId','externalMessageId',points=[(2088,360),m.port('MessageId','t')])
    m.msg('e','Webhook','Texto / áudio',points=[(130,360),(130,650),(188,650),m.port('Webhook','t')])
    m.node('b','ClaimStart','Pedido de próxima revisão','startEvent',300,1044,event='message')
    m.node('b','Reserve','Consultar fila e reservar uma revisão','serviceTask',470,1020,w=220)
    m.node('b','ClaimResponse','Retornar queueState e review','sendTask',795,1020,w=210)
    m.node('b','ClaimEnd','Consulta concluída','endEvent',1120,1044);m.chain('ClaimStart','Reserve','ClaimResponse','ClaimEnd')
    m.msg('Claim','ClaimStart','POST /next',points=[m.port('Claim','b'),(365,525),(235,525),(235,975),(318,975),m.port('ClaimStart','t')])
    m.msg('ClaimResponse','ClaimOk','queueState + review',points=[m.port('ClaimResponse','t'),(900,935),(815,935),(815,506),(693,506),m.port('ClaimOk','b')])
    m.node('b','ReplyStart','Decisão recebida','startEvent',300,1284,event='message')
    m.node('b','Validate','Localizar revisão citada; validar estado e categoria','serviceTask',470,1260,w=220)
    m.node('b','Confirm','Confirmar categoria; salvar regra se solicitado; resolver revisão','subProcess',795,1260,w=240,doc='Atualiza categoria primária, classification CLASSIFIED e review RESOLVED; a merchant_rule opcional é gravada na mesma transação do Postgres.')
    m.node('b','NextClaim','Reservar próxima revisão','serviceTask',1120,1260,w=190)
    m.node('b','ReplyResponse','Retornar confirmação + next','sendTask',1420,1260,w=205)
    m.node('b','ReplyEnd','Revisão concluída','endEvent',1740,1284);m.chain('ReplyStart','Validate','Confirm','NextClaim','ReplyResponse','ReplyEnd')
    m.msg('Reply','ReplyStart','POST /reply',points=[m.port('Reply','b'),(1225,1220),(318,1220),m.port('ReplyStart','t')])
    m.msg('ReplyResponse','ReplyOk','resolved + next',points=[m.port('ReplyResponse','t'),(1522.5,970),(1575,970),(1575,756),(1528,756),m.port('ReplyOk','b')])
    m.node('b','AttachStart','Vínculo recebido','startEvent',300,1524,event='message')
    m.node('b','SaveId','Salvar ID externo; marcar WAITING_REPLY','serviceTask',470,1500,w=220)
    m.node('b','AttachResponse','Responder vínculo registrado','sendTask',795,1500,w=210)
    m.node('b','AttachEnd','Vínculo concluído','endEvent',1120,1524);m.chain('AttachStart','SaveId','AttachResponse','AttachEnd')
    m.msg('Attach','AttachStart','PATCH /:reviewId/message',points=[m.port('Attach','b'),(2275,525),(2600,525),(2600,1460),(318,1460),m.port('AttachStart','t')])
    m.msg('AttachResponse','Attach','Confirmação do vínculo',points=[m.port('AttachResponse','b'),(900,1630),(2670,1630),(2670,480),m.port('Attach','r')])
    m.store('b','DB',2430,1320)
    m.edge('Confirm','DB',kind='association',points=[m.port('Confirm','b'),(915,1385),(2370,1385),(2370,1355),m.port('DB','l')])
    m.note('b','QueueNote','Fila atual: somente AI + PENDING_REVIEW + categoria sugerida. Uma revisão ativa por tenant. CLAIMED tem lease de 15 min; WAITING_REPLY bloqueia novo envio.',1280,1000,430,120,target='Reserve')
    m.note('b','RuleNote','Merchant Rules: padrão EXACT ou CONTAINS, contexto/ direção/operação e prioridade. Futuras transações compatíveis são classificadas diretamente.',1870,1150,460,110,target='Confirm')
    m.note('b','Errors','Validação/revisão inválida: erro HTTP. RESOLVED repetida: resposta idempotente, sem next. Respostas HTTP de erro estão nos ramos do n8n; trajetos internos condensados.',1870,1670,680,80)
    return m

def monthly():
    m=Model('Monthly','As Is · 2. Relatório mensal e lembrete de importação',2250,1450)
    m.pool('u','Usuário',110,155);m.pool('e','Evolution',290,70,False);m.pool('n','n8n',390,540);m.pool('b','Backend',970,400)
    m.node('u','ReminderIn','Lembrete recebido','startEvent',490,153,event='message')
    m.node('u','ReadReminder','Ler aviso para importar extrato','userTask',610,128,w=185)
    m.node('u','ReminderEnd','Aviso recebido','endEvent',880,153);m.chain('ReminderIn','ReadReminder','ReminderEnd')
    m.node('u','ReportIn','Relatório recebido','startEvent',1430,153,event='message')
    m.node('u','ReadReport','Consultar resumo mensal','userTask',1550,128,w=185)
    m.node('u','UserEnd','Resumo consultado','endEvent',1820,153);m.chain('ReportIn','ReadReport','UserEnd')
    m.node('n','MonthlyTimer','Agendamento mensal','startEvent',170,444,event='timer')
    m.node('n','Period','Definir mês, ano e conta opcional','serviceTask',290,420,w=185)
    m.node('n','GetReport','Solicitar relatório ao backend','sendTask',560,420,doc='GET /report?month=...&year=...; accountId opcional. Hora e período exatos do schedule não legíveis na print.')
    m.http('n','GetReport','WaitReport','ReportOk','ReportError','ReportFail',800,420)
    m.node('n','Format','Formatar mensagem do resumo','serviceTask',1150,420,w=185)
    m.node('n','SendReport','Enviar relatório via Evolution','sendTask',1450,420,w=185)
    m.node('n','ReportEnd','Relatório enviado','endEvent',1770,444)
    m.chain('MonthlyTimer','Period','GetReport');m.chain('ReportOk','Format','SendReport','ReportEnd')
    m.node('n','ReminderTimer','Dia 1 do mês','startEvent',170,764,event='timer',doc='Lembrete independente para importar o extrato; não bloqueia o outro schedule, conforme print e descrição do usuário.')
    m.node('n','PrepareReminder','Preparar lembrete de importação','serviceTask',290,740,w=185)
    m.node('n','SendReminder','Enviar aviso via Evolution','sendTask',610,740,w=185)
    m.node('n','ReminderDone','Lembrete enviado','endEvent',880,764);m.chain('ReminderTimer','PrepareReminder','SendReminder','ReminderDone')
    m.msg('SendReport','e','Resumo mensal',points=[m.port('SendReport','t'),(1542.5,360)])
    m.msg('e','ReportIn','Relatório',points=[(1448,290),m.port('ReportIn','b')])
    m.msg('SendReminder','e','Aviso de importação',points=[m.port('SendReminder','t'),(702.5,650),(520,650),(520,360)])
    m.msg('e','ReminderIn','Lembrete',points=[(508,290),m.port('ReminderIn','b')])
    m.node('b','Request','Pedido de relatório','startEvent',300,1064,event='message')
    m.node('b','Validate','Validar período e parâmetros','serviceTask',450,1040,w=185)
    m.node('b','Query','Consultar transações do período','serviceTask',745,1040,w=185)
    m.node('b','Calculate','Calcular receitas, despesas, saldo, categorias e top 3','serviceTask',1030,1040,w=215)
    m.node('b','Response','Retornar relatório em JSON','sendTask',1360,1040,w=185)
    m.node('b','End','Relatório calculado','endEvent',1680,1064);m.chain('Request','Validate','Query','Calculate','Response','End')
    m.msg('GetReport','Request','GET /report',points=[m.port('GetReport','b'),(645,550),(815,550),(815,985),(318,985),m.port('Request','t')])
    m.msg('Response','ReportOk','JSON do relatório',points=[m.port('Response','t'),(1452.5,960),(995,960),(995,524),(958,524),m.port('ReportOk','b')])
    m.store('b','DB',1850,1100);m.edge('DB','Query',kind='association',points=[m.port('DB','l'),(1790,1135),(1790,1170),(837.5,1170),m.port('Query','b')])
    m.note('b','ReportNote','Consulta: POSTED, não ignoradas, tenant e mês/ano; conta opcional. Totais: INCOME e EXPENSE. Transferências/investimentos/ajustes fora do saldo. Sem categoria → SEM_CATEGORIA. Mês vazio → totais zero.',470,1200,1020,110,target='Query')
    m.note('n','ScheduleNote','Dois schedules independentes: lembrete no dia 1 e geração do relatório. Não há dependência automática que aguarde a importação antes do cálculo.',1150,755,720,95)
    return m

def imports():
    m=Model('Import','As Is · 3. Importação de extratos Inter por e-mail',2970,1730)
    m.pool('u','Usuário',110,65,False);m.pool('e','Evolution',200,65,False);m.pool('n','n8n',305,490);m.pool('b','Backend',835,820)
    m.node('n','Timer','Busca periódica','startEvent',155,389,event='timer')
    m.node('n','Search','Buscar e-mails do Inter no Gmail','serviceTask',255,365,w=175)
    m.node('n','Found','Há e-mails?','exclusiveGateway',480,384)
    m.node('n','Empty','Nenhuma importação','endEvent',560,639)
    m.node('n','Full','Ler mensagem completa e filtrar anexos CSV','serviceTask',590,365,w=190)
    m.node('n','Download','Baixar anexo CSV','serviceTask',845,365,w=160)
    m.node('n','Convert','Converter para arquivo binário','serviceTask',1070,365,w=175)
    m.node('n','Upload','Enviar extrato ao Copiloto','sendTask',1310,365,w=185,doc='Rota assumida /imports/statements, format INTER_CSV e source GMAIL/N8N. A rota não é legível na print; confirmar na configuração do nó copilotoPost. Não é o CSV genérico com previewToken.')
    m.http('n','Upload','Wait','UploadOk','UploadError','UploadFail',1570,365)
    m.node('n','Read','Marcar mensagem como lida no Gmail','serviceTask',1960,365,w=195)
    m.node('n','More','Mais e-mails?','exclusiveGateway',2280,384)
    m.node('n','End','Importações concluídas','endEvent',2490,389)
    m.chain('Timer','Search','Found');m.edge('Found','Empty','Não',sides=('b','l'));m.edge('Found','Full','Sim')
    m.chain('Full','Download','Convert','Upload');m.chain('UploadOk','Read','More');m.edge('More','End','Não')
    m.edge('More','Full','Sim: próximo e-mail',points=[m.port('More','b'),(2303,695),(680,695),m.port('Full','b')],sides=('b','b'))
    m.note('n','MailNote','Gmail/Inter é serviço externo acessado por tarefas do n8n. Usuário e Evolution não participam diretamente desta importação. Consulta/filtros exatos do Gmail não legíveis nas prints.',2100,535,580,110)
    m.node('b','Request','Extrato recebido','startEvent',250,929,event='message')
    m.node('b','Validate','Validar upload, formato e conta','serviceTask',390,905,w=190)
    m.node('b','Claim','Registrar lote e verificar origem/hash','serviceTask',670,905,w=200)
    m.node('b','New','Lote novo?','exclusiveGateway',955,924)
    m.node('b','Parse','Interpretar CSV Inter; normalizar movimentos','serviceTask',1080,905,w=210)
    m.node('b','Persist','Persistir movimentos e evitar duplicatas','serviceTask',1370,905,w=210)
    m.node('b','Classify','Classificar cada transação: Merchant Rules → IA','subProcess',1660,905,w=220)
    m.node('b','Finish','Finalizar lote e contabilizar resultados','serviceTask',1950,905,w=215)
    m.node('b','Response','Retornar resumo da importação','sendTask',2240,905,w=195)
    m.node('b','BackendEnd','Importação processada','endEvent',2580,929)
    m.chain('Request','Validate','Claim','New');m.edge('New','Parse','Sim');m.chain('Parse','Persist','Classify','Finish','Response','BackendEnd')
    m.node('b','Conflict','Retornar conflito de origem / lote repetido','sendTask',1070,1175,w=220)
    m.node('b','ConflictEnd','Sem nova importação','endEvent',1430,1199)
    m.edge('New','Conflict','Não: HTTP 409',sides=('b','l'));m.chain('Conflict','ConflictEnd')
    m.msg('Upload','Request','POST /imports/statements',points=[m.port('Upload','b'),(1402.5,810),(268,810),m.port('Request','t')])
    m.msg('Response','UploadOk','HTTP 201 + contadores',points=[m.port('Response','t'),(2337.5,825),(1790,825),(1790,469),(1728,469),m.port('UploadOk','b')])
    m.msg('Conflict','UploadError','HTTP 409',points=[m.port('Conflict','b'),(1180,1310),(1820,1310),(1820,565),m.port('UploadError','r')])
    m.store('b','DB',2410,1350)
    m.edge('Persist','DB',kind='association',points=[m.port('Persist','b'),(1475,1430),(2360,1430),(2360,1385),m.port('DB','l')])
    m.note('b','ClassifierNote','As Is: regra compatível → CLASSIFIED por RULE. Sem regra → IA sugere categoria e grava PENDING_REVIEW. Falha da IA ou categoria inválida → pendência sem sugestão; claim next não inclui esses casos.',1510,1160,720,125,target='Classify')
    m.note('b','BatchNote','Lote IMPORTED ou NEEDS_REVIEW se alguma classificação falhar. Erro de parse/persistência marca FAILED e retorna erro HTTP. Detalhes de exceção condensados; a mensagem só segue para "lida" após resposta de sucesso.',1510,1520,940,95)
    m.note('n','Assumption','Ponto a confirmar: rota do nó copilotoPost. Modelo adota /imports/statements por aceitar INTER_CSV e disparar o classificador. /imports/csv é outro contrato, exige previewToken e não chama IA.',1050,550,650,100)
    return m

def future():
    m=Model('Future','To Be · Classificação com CNPJ e decisão por confiança',3010,1600)
    m.pool('u','Usuário',110,150);m.pool('e','Evolution',285,65,False);m.pool('n','n8n',390,210);m.pool('cnpj','API de CNPJ',635,65,False);m.pool('b','Backend',745,770)
    m.node('u','UserStart','Caso para revisar','startEvent',2100,155,event='message')
    m.node('u','Decision','Confirmar categoria e regra opcional','userTask',2210,132,w=205)
    m.node('u','Reply','Responder via WhatsApp','sendTask',2510,132,w=180)
    m.node('u','UserEnd','Decisão enviada','endEvent',2800,155);m.chain('UserStart','Decision','Reply','UserEnd')
    m.node('n','ReviewStart','Revisão humana disponível','startEvent',1500,464,event='message')
    m.node('n','ExistingReview','Executar fluxo de revisão atual e retornar decisão','subProcess',1700,440,w=310,doc='Reutilizar As Is 1: claim next, envio e vínculo da mensagem, webhook, agrupamento, reply e next. No futuro deve abranger também casos de baixa confiança e falhas sem sugestão.')
    m.node('n','ReviewEnd','Revisão finalizada','endEvent',2190,464);m.chain('ReviewStart','ExistingReview','ReviewEnd')
    m.msg('ExistingReview','e','Pergunta / confirmação',points=[m.port('ExistingReview','t'),(1855,350)])
    m.msg('e','UserStart','Transação suspeita',points=[(2118,285),m.port('UserStart','b')])
    m.msg('Reply','e','Resposta',points=[m.port('Reply','b'),(2600,285)])
    m.msg('e','ExistingReview','Webhook de resposta',points=[(1970,350),(1970,410),(2025,410),(2025,482),m.port('ExistingReview','r')])
    m.node('b','Start','Transação a classificar','startEvent',160,864)
    m.node('b','Rules','Consultar Merchant Rules','serviceTask',285,840,w=190)
    m.node('b','Match','Regra compatível?','exclusiveGateway',565,859)
    m.node('b','RuleClass','Aplicar categoria da regra','serviceTask',735,785,w=185)
    m.node('b','RuleEnd','Classificação direta','endEvent',1060,809)
    m.chain('Start','Rules','Match');m.edge('Match','RuleClass','Sim',sides=('t','l'));m.chain('RuleClass','RuleEnd')
    m.node('b','CnpjPossible','CNPJ identificável?','exclusiveGateway',735,1029)
    m.edge('Match','CnpjPossible','Não',sides=('b','l'))
    m.node('b','CnpjRequest','Consultar dados da empresa','sendTask',875,1005,w=185)
    m.http('b','CnpjRequest','WaitCnpj','CnpjOk','CnpjError','UnusedErrorEnd',1140,1005)
    # Replace the generic failure end: API failure also goes to human review.
    end_id=m.id('UnusedErrorEnd');end_elem=m.items['UnusedErrorEnd'][0]
    proc=m.procs['b'];proc.remove(end_elem)
    for sf in list(proc.findall('bpmn:sequenceFlow',NS)):
        if sf.get('targetRef')==end_id:
            proc.remove(sf)
            for inc in list(m.items['CnpjError'][0].findall('bpmn:outgoing',NS)):
                if inc.text==sf.get('id'):m.items['CnpjError'][0].remove(inc)
            for ed in list(m.plane):
                if ed.get('bpmnElement')==sf.get('id'):m.plane.remove(ed)
    for sh in list(m.plane):
        if sh.get('bpmnElement')==end_id:m.plane.remove(sh)
    m.shapes=[x for x in m.shapes if x[0]!='UnusedErrorEnd'];m.edges=m.edges[:-1];del m.items['UnusedErrorEnd']
    m.node('b','AI','Enviar contexto enriquecido à IA e validar sugestão','serviceTask',1490,1005,w=235)
    m.node('b','Safe','Alta confiança e caso não ambíguo?','exclusiveGateway',1820,1024)
    m.node('b','Auto','Confirmar categoria automaticamente','serviceTask',2040,855,w=220)
    m.node('b','AutoEnd','Classificação automática','endEvent',2410,879)
    m.node('b','Pending','Gravar pendência de revisão humana','serviceTask',2040,1200,w=220)
    m.node('b','Notify','Disponibilizar caso ao n8n','sendTask',2390,1200,w=200)
    m.node('b','PendingEnd','Aguardar confirmação humana','endEvent',2780,1224)
    m.edge('CnpjPossible','CnpjRequest','Sim');m.chain('CnpjOk','AI','Safe');m.edge('Safe','Auto','Sim',sides=('t','l'));m.chain('Auto','AutoEnd')
    m.edge('Safe','Pending','Não / PIX ambíguo / sugestão inválida',sides=('b','l'))
    m.edge('CnpjPossible','Pending','Não: contraparte insuficiente',points=[m.port('CnpjPossible','b'),(758,1400),(2000,1400),(2000,1242),m.port('Pending','l')],sides=('b','l'))
    m.edge('CnpjError','Pending','Dados indisponíveis',points=[m.port('CnpjError','b'),(1298,1335),(1980,1335),(1980,1242),m.port('Pending','l')],sides=('b','l'))
    m.chain('Pending','Notify','PendingEnd')
    m.msg('CnpjRequest','cnpj','CNPJ / identificação',points=[m.port('CnpjRequest','t'),(967.5,700)])
    m.msg('cnpj','CnpjOk','Dados da empresa',points=[(1298,700),m.port('CnpjOk','t')])
    m.msg('Notify','ReviewStart','Caso pendente',points=[m.port('Notify','t'),(2490,720),(1518,720),m.port('ReviewStart','b')])
    m.store('b','DB',2800,850)
    m.edge('Auto','DB',kind='association',points=[m.port('Auto','b'),(2150,980),(2730,980),(2730,885),m.port('DB','l')])
    m.note('b','Policy','Proposta futura; ainda não implementada. Limiar de confiança, critérios de ambiguidade, fornecedor de CNPJ e forma de identificar a empresa ficam a definir. Não criar Merchant Rule automaticamente a partir de uma sugestão da IA.',1340,780,650,100)
    return m

def validate(model):
    ids=[e.get('id') for e in model.root.iter() if e.get('id')]
    assert len(ids)==len(set(ids)), ('duplicate IDs',[i for i in set(ids) if ids.count(i)>1])
    index={e.get('id'):e for e in model.root.iter() if e.get('id')}
    for e in model.root.iter():
        for k in ['sourceRef','targetRef','processRef','bpmnElement','dataStoreRef']:
            if e.get(k): assert e.get(k) in index,(e.get('id'),k,e.get(k))
    for p in model.root.findall('bpmn:process',NS):
        nodes={e.get('id'):e for e in p if e.get('id')}
        for f in p.findall('bpmn:sequenceFlow',NS):
            assert f.get('sourceRef') in nodes and f.get('targetRef') in nodes
        for n in nodes.values():
            tag=n.tag.split('}')[-1]
            if tag in ['startEvent','endEvent','serviceTask','sendTask','userTask','subProcess','intermediateCatchEvent','exclusiveGateway','eventBasedGateway']:
                incoming=n.findall('bpmn:incoming',NS);outgoing=n.findall('bpmn:outgoing',NS)
                assert incoming or tag=='startEvent',(n.get('id'),'missing incoming')
                assert outgoing or tag=='endEvent',(n.get('id'),'missing outgoing')
            if tag=='eventBasedGateway':
                assert len(outgoing)>=2
                for o in outgoing:
                    f=index[o.text];target=index[f.get('targetRef')]
                    assert target.tag.endswith('intermediateCatchEvent')
                    assert len(target.findall('bpmn:incoming',NS))==1
    shapes={e.get('bpmnElement') for e in model.plane.findall('bpmndi:BPMNShape',NS)}
    for e in model.root.iter():
        if e.tag.split('}')[-1] in ['participant','startEvent','endEvent','serviceTask','sendTask','userTask','subProcess','intermediateCatchEvent','exclusiveGateway','eventBasedGateway','dataStoreReference','textAnnotation']:
            assert e.get('id') in shapes, (e.get('id'),'missing DI shape')
    return {'diagram':model.title,'ids':len(ids),'shapes':len(shapes),'eventGateways':len(model.root.findall('.//bpmn:eventBasedGateway',NS)),'structuralValidation':'PASS'}

models=[classify(),monthly(),imports(),future()]
filenames=['01-classificacao-as-is.bpmn','02-relatorio-mensal-as-is.bpmn','03-importacao-email-as-is.bpmn','04-classificacao-to-be.bpmn']
results=[]
for m,f in zip(models,filenames):
    results.append(validate(m));m.write(f)
# The combined file contains three independent collaborations, with unique IDs and DI.
combined=E.Element('{'+NS['bpmn']+'}definitions', {'id':'Copiloto_AsIs_Definitions','targetNamespace':'https://copiloto-financeiro.local/bpmn','exporter':'Copiloto Financeiro'})
for m in models[:3]:
    for child in m.root:
        if child.tag!='{'+NS['bpmndi']+'}BPMNDiagram':combined.append(copy.deepcopy(child))
for m in models[:3]:combined.append(copy.deepcopy(m.diag))
E.indent(combined);E.ElementTree(combined).write(OUT/'copiloto-financeiro-as-is.bpmn',encoding='utf-8',xml_declaration=True)
(OUT/'validacao.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
cards=''.join(f'<section id="d{i}"><h2>{html.escape(m.title)}</h2><p><a download href="{f}">Baixar BPMN editável</a> · <a target="_blank" href="{f[:-5]}.svg">Abrir imagem ampliada</a></p><div class="diagram">{(OUT/f.replace(".bpmn",".svg")).read_text(encoding="utf-8")}</div></section>' for i,(m,f) in enumerate(zip(models,filenames)))
page='''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>BPMN · Copiloto Financeiro</title><style>body{margin:0;background:#edf2f7;color:#18344b;font:16px Arial}header{padding:28px 40px;background:#173950;color:white}h1{margin:0 0 12px}nav{display:flex;gap:22px;flex-wrap:wrap}header a{color:#e6f3ff}main{padding:24px 32px}section{background:white;border-radius:12px;margin-bottom:28px;padding:20px;box-shadow:0 4px 18px #17395012}h2{font-size:21px}.diagram{overflow:auto;border:1px solid #ced8e0}.diagram svg{display:block;width:100%;height:auto;min-width:1200px}a{color:#146ab2}.toolbar{position:sticky;top:0;background:#edf2f7;padding:12px;z-index:2}button{padding:8px 16px;cursor:pointer}small{color:#456}<\/style></head><body><header><h1>Copiloto Financeiro · Processos BPMN</h1><p>Estado atual baseado no backend, nas prints e na descrição do processo. Evolução futura em diagrama separado.</p><nav><a href="#d0">1. Classificação</a><a href="#d1">2. Relatório mensal</a><a href="#d2">3. Importação</a><a href="#d3">4. To Be</a><a href="README.md">Notas e fontes</a></nav></header><main><div class="toolbar"><button onclick="zoom(.25)">Ampliar +</button> <button onclick="zoom(-.25)">Reduzir −</button> <button onclick="reset()">Ajustar à largura</button> <small>Use a barra horizontal para navegar quando ampliar.</small></div>CARDS</main><script>let scale=1;function apply(){document.querySelectorAll('.diagram svg').forEach(x=>x.style.width=(scale*100)+'%')}function zoom(v){scale=Math.max(.5,Math.min(4,scale+v));apply()}function reset(){scale=1;apply()}</script></body></html>'''.replace('<\\/style>','</style>').replace('CARDS',cards)
(OUT/'visualizar.html').write_text(page,encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))
