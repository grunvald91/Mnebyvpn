#!/usr/bin/env python3
"""Read-only public-site crawler smoke test. No account/login/secret requests."""
from html.parser import HTMLParser
import ssl
import sys
import urllib.error
import urllib.request

ORIGIN="https://mnebyvpn.site"
ROUTES=(
    "/", "/robots.txt", "/sitemap.xml", "/terms", "/privacy",
    "/agreement", "/landing-art.html", "/payment/success",
    "/index.html", "/terms.html", "/privacy.html", "/agreement.html",
    "/payment/return", "/seo-nonexistent-20261113",
)
class Meta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title=self.description=self.canonical=self.robots=""
        self.in_title=False
        self.h1=0
    def handle_starttag(self,tag,attrs):
        d=dict(attrs)
        if tag=="title":self.in_title=True
        if tag=="h1":self.h1+=1
        if tag=="meta" and d.get("name")=="description":
            self.description=d.get("content","")
        if tag=="meta" and d.get("name")=="robots":
            self.robots=d.get("content","")
        if tag=="link" and d.get("rel")=="canonical":
            self.canonical=d.get("href","")
    def handle_endtag(self,tag):
        if tag=="title":self.in_title=False
    def handle_data(self,s):
        if self.in_title:self.title+=s

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,newurl):
        return None

failures=[]
opener=urllib.request.build_opener(
    NoRedirect(),
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
)
for path in ROUTES:
    req=urllib.request.Request(ORIGIN+path,headers={"User-Agent":"MNEBYVPN-own-site-SEO-audit/1.0","Accept":"*/*"})
    try:
        r=opener.open(req,timeout=11)
    except urllib.error.HTTPError as exc:
        r=exc
    except Exception as exc:
        print("PATH="+path+" transport="+type(exc).__name__,flush=True)
        failures.append(path+": network error")
        continue
    with r:
        body=r.read(700000).decode("utf-8",errors="replace")
        h=r.headers
        meta=Meta()
        if "text/html" in h.get("Content-Type",""):meta.feed(body)
        print("PATH="+path+" code="+str(r.status)+" content_type="+h.get("Content-Type","")[:54]+
              " xrobots="+h.get("X-Robots-Tag","none")[:45]+
              " title="+str(bool(meta.title))+" description="+str(bool(meta.description))+
              " canonical="+(meta.canonical or "none")[:90]+
              " location="+h.get("Location","none")[:95]+
              " h1="+str(meta.h1)+
              " robots_map="+str("Sitemap:" in body and "/sitemap.xml" in body)+
              " xml_urlset="+str("<urlset" in body),flush=True)
        if path in ("/","/terms","/privacy","/agreement"):
            expected="https://mnebyvpn.site"+path
            if r.status!=200 or not meta.description or meta.canonical!=expected:
                failures.append(path+": canonical/description/status")
        elif path=="/robots.txt":
            if r.status!=200 or not ("Sitemap: https://mnebyvpn.site/sitemap.xml" in body):
                failures.append(path+": robots unavailable")
        elif path=="/sitemap.xml":
            if r.status!=200 or '<urlset' not in body or '<loc>https://mnebyvpn.site/</loc>' not in body:
                failures.append(path+": sitemap unavailable")
        elif path in ("/index.html","/terms.html","/privacy.html","/agreement.html"):
            canonical={"/index.html":"/","/terms.html":"/terms",
                       "/privacy.html":"/privacy","/agreement.html":"/agreement"}[path]
            if r.status!=301 or h.get("Location")!=canonical:
                failures.append(path+": duplicate redirect")
        elif path in ("/landing-art.html","/payment/success","/payment/return"):
            if r.status!=200 or "noindex" not in h.get("X-Robots-Tag",""):
                failures.append(path+": noindex absent")
        elif path=="/seo-nonexistent-20261113":
            if r.status!=404 or "noindex" not in h.get("X-Robots-Tag",""):
                failures.append(path+": incorrect 404")
if failures:
    for issue in failures:print("SEO_CRAWLER_REGRESSION="+issue,flush=True)
    sys.exit(1)
print("SEO_PUBLIC_AUDIT_READ_ONLY=true")
print("SEO_PUBLIC_CRAWLER_GATE=PASS")
