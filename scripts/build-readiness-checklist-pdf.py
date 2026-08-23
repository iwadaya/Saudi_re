# -*- coding: utf-8 -*-
import re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from readiness_checklist_content import SECTIONS, APPENDIX

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether, PageBreak,
                                NextPageTemplate)

# ── palette ────────────────────────────────────────────────────────────────
INK     = colors.HexColor('#12161C')
BODY    = colors.HexColor('#2C333D')
MUTED   = colors.HexColor('#61697A')
RULE    = colors.HexColor('#DCE0E7')
BAND    = colors.HexColor('#1B2A3C')
ACCENT  = colors.HexColor('#0F5D8C')
CODE    = colors.HexColor('#1F4A66')
P1      = colors.HexColor('#B02A22')
P2      = colors.HexColor('#B5711A')
P3      = colors.HexColor('#5C6472')
CRIT    = colors.HexColor('#8B1A14')
TINT    = colors.HexColor('#F4F6F9')

PRI_COLOR = {'P1': P1, 'P2': P2, 'P3': P3}
SEV_COLOR = {'Critical': CRIT, 'High': P1, 'Medium': P2, 'Low': P3}

PAGE_W, PAGE_H = A4
LM, RM, TM, BM = 17*mm, 15*mm, 20*mm, 18*mm
CONTENT_W = PAGE_W - LM - RM

# ── inline markup: `code` → mono, **bold** → bold, with XML escaping ────────
def esc(t):
    return (t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

def rich(text, code_size=None):
    out, last = [], 0
    for m in re.finditer(r'`([^`]+)`', text):
        out.append(esc(text[last:m.start()]))
        sz = f' size="{code_size}"' if code_size else ''
        out.append(f'<font face="Courier"{sz} color="#1F4A66">{esc(m.group(1))}</font>')
        last = m.end()
    out.append(esc(text[last:]))
    s = ''.join(out)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    return s

# ── styles ─────────────────────────────────────────────────────────────────
def st(name, **kw):
    base = dict(fontName='Helvetica', fontSize=8.6, leading=11.4, textColor=BODY)
    base.update(kw)
    return ParagraphStyle(name, **base)

S_TITLE    = st('t',  fontName='Helvetica-Bold', fontSize=27, leading=31, textColor=INK)
S_SUB      = st('s',  fontName='Helvetica',      fontSize=13, leading=17, textColor=ACCENT)
S_COVER    = st('c',  fontSize=9.6, leading=14.4, textColor=BODY)
S_COVERH   = st('ch', fontName='Helvetica-Bold', fontSize=8.2, leading=11, textColor=MUTED)
S_SECNUM   = st('sn', fontName='Helvetica-Bold', fontSize=15, leading=17, textColor=colors.white)
S_SECTTL   = st('sx', fontName='Helvetica-Bold', fontSize=13, leading=16, textColor=colors.white)
S_BLURB    = st('bl', fontSize=8.8, leading=12.4, textColor=MUTED)
S_TASK     = st('tk', fontName='Helvetica-Bold', fontSize=9.0, leading=11.8, textColor=INK)
S_META     = st('mt', fontSize=7.7, leading=10.4, textColor=BODY)
S_ID       = st('id', fontName='Helvetica-Bold', fontSize=7.8, leading=9.6, textColor=MUTED, alignment=TA_CENTER)
S_PRI      = st('pr', fontName='Helvetica-Bold', fontSize=6.6, leading=8.4, textColor=colors.white, alignment=TA_CENTER)
S_H2       = st('h2', fontName='Helvetica-Bold', fontSize=11, leading=14, textColor=INK)
S_NOTE     = st('nt', fontSize=8.6, leading=12, textColor=BODY)
S_FIND     = st('fd', fontSize=8.3, leading=11.4, textColor=BODY)
S_FINDT    = st('ft', fontName='Helvetica-Bold', fontSize=9.2, leading=11.8, textColor=INK)
S_TH       = st('th', fontName='Helvetica-Bold', fontSize=7.8, leading=10, textColor=colors.white)

# ── page furniture ─────────────────────────────────────────────────────────
DOCTITLE = 'Enterprise Readiness Review'
REPO     = 'Universe 3  ·  darchville-analytics/modelling_tool'

def draw_frame(canv, doc, cover=False):
    canv.saveState()
    if not cover:
        canv.setFont('Helvetica', 7)
        canv.setFillColor(MUTED)
        canv.drawString(LM, PAGE_H - 12*mm, DOCTITLE)
        canv.drawRightString(PAGE_W - RM, PAGE_H - 12*mm, REPO)
        canv.setStrokeColor(RULE); canv.setLineWidth(0.5)
        canv.line(LM, PAGE_H - 14*mm, PAGE_W - RM, PAGE_H - 14*mm)
        canv.line(LM, 13*mm, PAGE_W - RM, 13*mm)
        canv.setFont('Helvetica', 7); canv.setFillColor(MUTED)
        canv.drawString(LM, 9*mm, 'Reviewer: ______________________     Date: ____________')
        canv.setFont('Helvetica-Bold', 7.5); canv.setFillColor(BODY)
        canv.drawRightString(PAGE_W - RM, 9*mm, str(canv.getPageNumber()))
    canv.restoreState()

def on_cover(canv, doc):
    canv.saveState()
    canv.setFillColor(BAND)
    canv.rect(0, PAGE_H - 69*mm, PAGE_W, 69*mm, stroke=0, fill=1)
    canv.setFillColor(ACCENT)
    canv.rect(0, PAGE_H - 71.5*mm, PAGE_W, 2.5*mm, stroke=0, fill=1)
    canv.restoreState()

def on_body(canv, doc):
    draw_frame(canv, doc)

# ── section header band ────────────────────────────────────────────────────
def section_header(num, title, blurb):
    inner = Table([[Paragraph(num, S_SECNUM), Paragraph(esc(title), S_SECTTL)]],
                  colWidths=[13*mm, CONTENT_W - 13*mm - 8*mm])
    inner.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('LEFTPADDING', (0,0), (0,0), 5), ('RIGHTPADDING', (0,0), (0,0), 2),
        ('LEFTPADDING', (1,0), (1,0), 3),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LINEAFTER', (0,0), (0,0), 0.7, colors.HexColor('#4A6customized')) if False else ('LINEAFTER', (0,0), (0,0), 0.7, colors.HexColor('#4A6480')),
    ]))
    band = Table([[inner]], colWidths=[CONTENT_W])
    band.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), BAND),
        ('LEFTPADDING', (0,0), (-1,-1), 4), ('RIGHTPADDING', (0,0), (-1,-1), 4),
        ('TOPPADDING', (0,0), (-1,-1), 1), ('BOTTOMPADDING', (0,0), (-1,-1), 1),
    ]))
    parts = [band, Spacer(1, 3.5)]
    if blurb:
        parts += [Paragraph(rich(blurb), S_BLURB), Spacer(1, 4)]
    return parts

# ── one checklist item ─────────────────────────────────────────────────────
CB_W, ID_W = 8*mm, 13*mm
TXT_W = CONTENT_W - CB_W - ID_W

def item_row(iid, pri, title, look, done, shade):
    pri_badge = Table([[Paragraph(pri, S_PRI)]], colWidths=[9*mm], rowHeights=[4.6*mm])
    pri_badge.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), PRI_COLOR[pri]),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 0),
        ('TOPPADDING', (0,0), (-1,-1), 0), ('BOTTOMPADDING', (0,0), (-1,-1), 0),
    ]))
    idcell = Table([[Paragraph(iid, S_ID)], [pri_badge]], colWidths=[ID_W - 3])
    idcell.setStyle(TableStyle([
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 0),
        ('TOPPADDING', (0,0), (0,0), 0), ('BOTTOMPADDING', (0,0), (0,0), 2),
        ('TOPPADDING', (0,1), (0,1), 0), ('BOTTOMPADDING', (0,1), (0,1), 0),
    ]))
    body = [
        Paragraph(rich(title), S_TASK),
        Spacer(1, 2),
        Paragraph('<font color="#61697A"><b>Look at</b></font>&nbsp;&nbsp;' + rich(look, 7.2), S_META),
        Spacer(1, 1.4),
        Paragraph('<font color="#61697A"><b>Done when</b></font>&nbsp;&nbsp;' + rich(done, 7.2), S_META),
    ]
    row = Table([['', idcell, body]], colWidths=[CB_W, ID_W, TXT_W])
    style = [
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 4), ('RIGHTPADDING', (0,0), (-1,-1), 4),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LINEBELOW', (0,0), (-1,-1), 0.4, RULE),
        ('LINEAFTER', (1,0), (1,0), 0.4, RULE),
    ]
    if shade:
        style.append(('BACKGROUND', (0,0), (-1,-1), TINT))
    row.setStyle(TableStyle(style))

    # checkbox drawn over the first cell
    class Box(Table):
        def draw(self):
            Table.draw(self)
            c = self.canv
            c.saveState()
            h = self._height
            c.setStrokeColor(colors.HexColor('#8C95A6')); c.setLineWidth(0.8)
            c.rect(LM*0 + 5, h - 12.5, 10, 10, stroke=1, fill=0)
            c.restoreState()
    row.__class__ = Box
    return row

def section_flow(sec):
    flow = section_header(sec['num'], sec['title'], sec['blurb'])
    rows = []
    for i, (iid, pri, title, look, done) in enumerate(sec['items']):
        rows.append(item_row(iid, pri, title, look, done, shade=(i % 2 == 1)))
    # keep the header with its first two items
    head = KeepTogether(flow + rows[:1])
    return [head] + rows[1:] + [Spacer(1, 7)]

# ── build ──────────────────────────────────────────────────────────────────
def cover(story, counts):
    story.append(Spacer(1, 14*mm))
    story.append(Paragraph('<font color="#FFFFFF">Enterprise Readiness</font>', S_TITLE))
    story.append(Paragraph('<font color="#FFFFFF">Review Checklist</font>', S_TITLE))
    story.append(Spacer(1, 5))
    story.append(Paragraph('<font color="#9FC4DC">Universe 3 — Reinsurance Treaty Pricing &amp; Modelling Tool</font>', S_SUB))
    story.append(Spacer(1, 24*mm))

    meta = [
        ('Repository',  'darchville-analytics/modelling_tool'),
        ('Stack',       'React 18 + Vite · Express 5 · PostgreSQL · ~250 server and ~400 client modules'),
        ('Audience',    'The software engineer performing the review'),
        ('Scope',       'Security and login · authorization · architecture · data · configuration · '
                        'supply chain · observability · resilience · performance · testing · compliance'),
        ('Contents',    f"{counts['items']} review tasks across {counts['sections']} areas, "
                        f"plus {counts['appx']} findings carried forward from the August 2026 audit"),
        ('Prepared',    '23 August 2026'),
    ]
    rows = [[Paragraph(k.upper(), S_COVERH), Paragraph(rich(v), S_COVER)] for k, v in meta]
    t = Table(rows, colWidths=[26*mm, CONTENT_W - 26*mm])
    t.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LINEBELOW', (0,0), (-1,-2), 0.4, RULE),
    ]))
    story.append(t)
    story.append(Spacer(1, 10*mm))

    how = (
        "<b>How to use this checklist.</b> Work top to bottom. Section 0 exists so that nothing below it is "
        "reviewed from reading alone — every finding should be demonstrable and every fix provable. "
        "Tick an item only when the <i>Done when</i> condition holds and you can point at the evidence: a test, "
        "a log line, a captured response, or a dated written decision.<br/><br/>"
        "<b>Priorities.</b> <font color=\"#B02A22\"><b>P1</b></font> blocks an enterprise deployment — do not sign off "
        "with one open. <font color=\"#B5711A\"><b>P2</b></font> should be closed before or shortly after go-live. "
        "<font color=\"#5C6472\"><b>P3</b></font> is hygiene and roadmap.<br/><br/>"
        "<b>Accepting risk is a valid outcome.</b> Several items ask for a decision rather than a change. A written, "
        "dated, signed-off acceptance closes the item; silence does not.<br/><br/>"
        "<b>Start with Appendix A.</b> Twelve findings from the August 2026 audit are reproduced at the back with file "
        "references. Confirm their current status before spending time anywhere else — A1 is a remotely exploitable "
        "path to the highest-privilege account and is enabled in the production manifest."
    )
    story.append(Paragraph(how, S_NOTE))
    story.append(NextPageTemplate('body'))
    story.append(PageBreak())

def appendix(story):
    story += section_header('A', 'Findings Carried Forward — Verify These First',
                            'Reproduced from `docs/CODEBASE_AUDIT_2026-08.md` and re-checked against the current tree on '
                            '23 August 2026. Each was still present at the time of writing. Confirm, then close or accept.')
    for fid, sev, title, detail, refs in APPENDIX:
        badge = Table([[Paragraph(sev, S_PRI)]], colWidths=[17*mm], rowHeights=[4.8*mm])
        badge.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), SEV_COLOR[sev]),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (-1,-1), 0), ('BOTTOMPADDING', (0,0), (-1,-1), 0),
        ]))
        left = Table([[Paragraph(fid, S_ID)], [badge]], colWidths=[17*mm])
        left.setStyle(TableStyle([
            ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (0,0), 0), ('BOTTOMPADDING', (0,0), (0,0), 2),
            ('TOPPADDING', (0,1), (0,1), 0), ('BOTTOMPADDING', (0,1), (0,1), 0),
        ]))
        body = [
            Paragraph(rich(title), S_FINDT),
            Spacer(1, 2.5),
            Paragraph(rich(detail, 7.4), S_FIND),
            Spacer(1, 2.5),
            Paragraph('<font color="#61697A"><b>Checklist items</b></font>&nbsp;&nbsp;' + esc(refs), S_META),
        ]
        row = Table([['', left, body]], colWidths=[CB_W, 19*mm, CONTENT_W - CB_W - 19*mm])
        row.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('LEFTPADDING', (0,0), (-1,-1), 4), ('RIGHTPADDING', (0,0), (-1,-1), 4),
            ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6),
            ('LINEBELOW', (0,0), (-1,-1), 0.4, RULE),
            ('LINEAFTER', (1,0), (1,0), 0.4, RULE),
        ]))
        class Box(Table):
            def draw(self):
                Table.draw(self)
                c = self.canv; h = self._height
                c.saveState()
                c.setStrokeColor(colors.HexColor('#8C95A6')); c.setLineWidth(0.8)
                c.rect(5, h - 13.5, 10, 10, stroke=1, fill=0)
                c.restoreState()
        row.__class__ = Box
        story.append(KeepTogether([row]))
    story.append(Spacer(1, 8))

def signoff(story):
    story.append(PageBreak())
    story += section_header('B', 'Sign-Off', 'Complete once every P1 above is closed or carries a written acceptance.')
    hdr = [Paragraph(h, S_TH) for h in ['Area', 'P1 open', 'P2 open', 'Accepted risks', 'Reviewed by', 'Date']]
    rows = [hdr]
    for sec in SECTIONS:
        rows.append([Paragraph(f"{sec['num']}  {esc(sec['title'])}", st('x', fontSize=8, leading=10)), '', '', '', '', ''])
    rows.append([Paragraph('<b>Overall — cleared for enterprise deployment</b>', st('y', fontSize=8, leading=10, textColor=INK)), '', '', '', '', ''])
    w = [CONTENT_W - (16+16+24+34+22)*mm, 16*mm, 16*mm, 24*mm, 34*mm, 22*mm]
    t = Table(rows, colWidths=w, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BAND),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('GRID', (0,0), (-1,-1), 0.4, RULE),
        ('BOX', (0,0), (-1,-1), 0.7, colors.HexColor('#B7BEC9')),
        ('LEFTPADDING', (0,0), (-1,-1), 5), ('RIGHTPADDING', (0,0), (-1,-1), 5),
        ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,0), 5), ('BOTTOMPADDING', (0,0), (-1,0), 5),
        ('BACKGROUND', (0,len(rows)-1), (-1,len(rows)-1), TINT),
        ('ROWBACKGROUNDS', (0,1), (-1,len(rows)-2), [colors.white, colors.HexColor('#FAFBFC')]),
    ]))
    story.append(t)
    story.append(Spacer(1, 8*mm))
    story.append(Paragraph(
        'A signature here states that the reviewer has personally verified each ticked item against the running system, '
        'and that every open risk is recorded, owned and accepted by a named person. Re-run this review at each major '
        'release, and after any change to authentication, authorization, or the production manifest.', S_BLURB))

def build(out):
    doc = BaseDocTemplate(out, pagesize=A4,
                          leftMargin=LM, rightMargin=RM, topMargin=TM, bottomMargin=BM,
                          title='Enterprise Readiness Review Checklist — Universe 3',
                          author='Engineering', subject='Codebase review checklist')
    fc = Frame(LM, BM, CONTENT_W, PAGE_H - TM - BM, id='cover',
               leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    fb = Frame(LM, BM, CONTENT_W, PAGE_H - TM - BM - 4*mm, id='body',
               leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([
        PageTemplate(id='cover', frames=[fc], onPage=on_cover),
        PageTemplate(id='body',  frames=[fb], onPage=on_body),
    ])
    counts = {'items': sum(len(s['items']) for s in SECTIONS),
              'sections': len(SECTIONS), 'appx': len(APPENDIX)}
    story = []
    cover(story, counts)
    for sec in SECTIONS:
        story += section_flow(sec)
    story.append(PageBreak())
    appendix(story)
    signoff(story)
    doc.build(story)
    print('wrote', out)

if __name__ == '__main__':
    build(sys.argv[1])
