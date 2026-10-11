"""Render the saved leave-passage audit and conditional identification ranges."""
from pathlib import Path
import argparse,json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

def run(directory,identification):
    a=json.loads((directory/'analysis.json').read_text(encoding='utf-8'))
    b=json.loads(identification.read_text(encoding='utf-8'))
    plt.rcParams.update({'font.family':'Meiryo','font.size':11,'axes.spines.top':False,'axes.spines.right':False})
    fig,axes=plt.subplots(1,2,figsize=(14,6),gridspec_kw={'width_ratios':[1.1,1]})
    fig.suptitle('2400 rpm / RO 7.5%：推定差の原因と、変更抑制項を使わない範囲',fontsize=17,x=.06,ha='left',y=.98)
    passes=a['passes'];values=[100*(p['fittedWithoutPass']-1) for p in passes]
    dominant=int(np.argmax([abs(p['gradientAtFull']) for p in passes]))
    labels=[f"{p['start']:.0f}–{p['end']:.0f}秒を除く" for p in passes]
    axes[0].barh(np.arange(len(passes)),values,color=['#df6b32' if i==dominant else '#547590' for i in range(len(passes))],height=.65)
    axes[0].set_yticks(np.arange(len(passes)),labels);axes[0].invert_yaxis()
    axes[0].axvline((a['factor']-1)*100,color='#183443',linestyle='--',label='全通過：−26.19%')
    axes[0].set_xlim(-33,1);axes[0].set_xlabel('その通過を学習から除いた場合の変更率 (%)')
    axes[0].set_title('主要通過を除くと −26.19% → −2.82%',loc='left',pad=15)
    for i,value in enumerate(values):axes[0].text(value+.3,i,f'{value:.2f}%',va='center',fontsize=10,color='white' if value<-10 else '#222')
    grid=next((r for r in b['results'] if r.get('kind')=='bounded'),None)
    if grid is None:raise ValueError('The current time-correlated command-grid result is required')
    if grid['range'] is None:raise ValueError('No solved grid range')
    lo,hi=(np.array(grid['range'])-1)*100
    full=(a['factor']-1)*100;weak=(a['folds'][-1]['fittedWithoutFold']-1)*100
    axes[1].scatter([full,weak],[0,1],s=80,c=['#547590','#df6b32'])
    for y,v in enumerate([full,weak]):axes[1].text(v,y-.2,f'{v:.2f}%',ha='center')
    axes[1].plot([lo,hi],[2,2],lw=9,solid_capstyle='round',color='#29856e')
    axes[1].text((lo+hi)/2,1.75,f'{lo:.2f} ～ {hi:.2f}%',ha='center')
    axes[1].axvline(0,color='#aaa',lw=1);axes[1].axvline(weak,color='#df6b32',linestyle=':')
    axes[1].set_yticks(range(3),['旧・全データの点推定','旧・最終区間を除外','P動作を扱う条件付き範囲']);axes[1].set_ylim(2.6,-.65)
    axes[1].set_xlim(-45,5);axes[1].set_xlabel('2400 rpm セルの変更率 (%)')
    axes[1].set_title('単一の確定値にはまだならない',loc='left',pad=15)
    fig.text(.06,.07,'右下：対象セルが寄与する375観測のみ・flow-0.25-mix・100msグリッド。全マップの検査では不成立。\n緑の範囲は入力・輸送仮説と隣接セル配分を残す条件付き結果で、信頼区間・書込み推奨値ではありません。',fontsize=10,color='#555')
    fig.subplots_adjust(left=.17,right=.97,top=.84,bottom=.23,wspace=.9)
    for extension in ['png','pdf']:fig.savefig(directory/f'2400-cause.{extension}',dpi=160,facecolor='white')
    plt.close(fig)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);p.add_argument('identification',type=Path)
    a=p.parse_args();run(a.directory,a.identification)
