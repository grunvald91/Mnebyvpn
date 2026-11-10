#!/usr/bin/env python3
"""Build a standalone, genuine Earth-textured neon globe backdrop.

Uses NASA's Blue Marble composite distributed in mpl_toolkits.basemap_data
(bundled bmng.jpg). This is a decorative image, never UI or a payment
simulation. Source coastlines come from actual Earth imagery, not wireframe.
Reproducible via the workflow committed alongside this script.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math
import numpy as np
import cv2
import random
import mpl_toolkits.basemap_data as basemap_data

random.seed(9)
W,H=900,790
# basemap_data is a namespace package, so __file__ may be None.
bmng=Path(next(iter(basemap_data.__path__)))/'bmng.jpg'
world=np.asarray(Image.open(bmng).convert('RGB'))
cy,cx,R=490,450,465
Y,X=np.mgrid[0:H,0:W].astype(np.float32)
x=(X-cx)/R;y=-(Y-cy)/R
inside=(x*x+y*y)<1
z=np.sqrt(np.maximum(0,1-x*x-y*y))
lon0=math.radians(36);lat0=math.radians(52)
lat=np.arcsin(np.clip(y*np.cos(lat0)+z*np.sin(lat0),-1,1))
lon=lon0+np.arctan2(x,z*np.cos(lat0)-y*np.sin(lat0))
lon=(lon+np.pi)%(2*np.pi)-np.pi
u=((lon+np.pi)/(2*np.pi)*(world.shape[1]-1)).astype(np.int32)
v=((np.pi/2-lat)/np.pi*(world.shape[0]-1)).astype(np.int32)
tex=world[v,u].astype(np.float32)
red,green,blue=tex[:,:,0],tex[:,:,1],tex[:,:,2]
land=(((green>blue*.67)&(red>blue*.57)&(green>28)) |
      ((red>100)&(red>blue*.75)))&inside
color=np.zeros((H,W,4),np.float32)
ocean=np.stack((5+11*z,25+37*z,79+66*z),axis=-1)
terrain=np.stack((35+65*z+red*.17,32+green*.14,92+blue*.22),axis=-1)
color[:,:,:3]=np.where(land[:,:,None],terrain,ocean)
coast=(cv2.morphologyEx(land.astype('uint8'),cv2.MORPH_GRADIENT,
       np.ones((3,3),'uint8'))>0)&inside
coast_glow=cv2.GaussianBlur(coast.astype(np.float32),(0,0),3.1)
# Amber city lights toward the west; purple lights toward eastern horizon.
west=np.clip((.75-x)*.85,0,1)[:,:,None]
coast_rgb=np.array([244,128,54])[None,None,:]*west + np.array([158,55,240])[None,None,:]*(1-west)
color[:,:,:3]+=coast_glow[:,:,None]*coast_rgb*3.0
color[:,:,:3]+=coast[:,:,None]*coast_rgb*.27
lights=np.zeros((H,W),np.float32)
candidates=np.argwhere(land&(z>.17)&(y>-.63)&(y<.8))
for _ in range(1100):
    iy,ix=candidates[random.randrange(len(candidates))]
    lights[int(iy),int(ix)]+=random.uniform(.35,1)
gold=cv2.GaussianBlur(lights,(0,0),2.0)
gold+=cv2.GaussianBlur(lights,(0,0),7)*1.8
color[:,:,:3]+=gold[:,:,None]*np.array([255,141,49])[None,None,:]*4.8
color[:,:,:3]+=lights[:,:,None]*np.array([255,188,113])[None,None,:]*.5
shade=np.clip(z**.45*.90+.08,0,1)*np.clip(.83+.25*y,.52,1.1)
color[:,:,:3]*=shade[:,:,None]
color[:,:,:3]+=np.maximum(0,-x)[:,:,None]*np.array([3,15,33])
color[:,:,:3]+=np.maximum(0,x)[:,:,None]*np.array([13,0,33])
color[:,:,3]=255*inside*np.clip(.73+.22*z,0,1)*np.clip((H-Y)/160,0,1)
planet=Image.fromarray(np.clip(color,0,255).astype('uint8'),'RGBA')
aura=Image.new('RGBA',(W,H))
d=ImageDraw.Draw(aura)
for scale,opacity,width in [(1.012,55,23),(1.003,95,10),(1,240,3)]:
    bb=(cx-R*scale,cy-R*scale,cx+R*scale,cy+R*scale)
    d.arc(bb,183,300,fill=(21,229,255,opacity),width=width)
    d.arc(bb,301,357,fill=(182,73,255,opacity),width=width)
aura=aura.filter(ImageFilter.GaussianBlur(2))
planet=Image.alpha_composite(planet,aura)
arc=Image.new('RGBA',(W,H));d=ImageDraw.Draw(arc)
points=[]
for theta in np.linspace(0,2*np.pi,700):
    xo=math.cos(theta)*560; yo=math.sin(theta)*154;phi=-.21
    px=cx+xo*math.cos(phi)-yo*math.sin(phi)
    py=cy+58+xo*math.sin(phi)+yo*math.cos(phi)
    points.append((px,py))
for i in range(1,len(points)):
    if not all(-20<a<W+20 for a in (points[i-1][0],points[i][0])):continue
    col=(32,215,255,170) if i<210 else (166,61,248,175)
    d.line((points[i-1],points[i]),fill=col,width=3)
planet=Image.alpha_composite(planet,arc)
# Fade the globe naturally behind the opaque tariff card.
alpha=np.asarray(planet.getchannel('A'),dtype=np.float32)
alpha*=np.clip((H-Y)/155,0,1)
planet.putalpha(Image.fromarray(alpha.astype('uint8')))
output=Path('apps/web/public/world-neon.webp')
output.parent.mkdir(parents=True,exist_ok=True)
planet.resize((780,685),Image.Resampling.LANCZOS).save(output,
    'WEBP',quality=56,method=6)
print(f'world_neon_webp={output.stat().st_size} bytes')
