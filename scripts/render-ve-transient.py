"""Render the read-only transient experiment into private plots and a Japanese report."""
from pathlib import Path
import argparse
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('analysis',type=Path)
args=parser.parse_args()
d=json.loads(args.analysis.read_text(encoding='utf-8'))
assert d['session']==967, 'This narrative renderer is specific to session #967; the numerical analyzer is generic.'
out=args.analysis.parent
models=d['models']
selected=[m for m in models if m['memorySec']==0 and m['regularization']==1]
labels=['0秒','0.25秒','0.5秒','1秒','2秒','流量A','流量B','流量C']
assert len(selected)==len(labels)==8
plt.rcParams['font.family']='Yu Gothic'
plt.rcParams['axes.unicode_minus']=False
fig,axes=plt.subplots(2,1,figsize=(11,8),layout='constrained')
x=np.arange(len(selected))
score=np.array([m['commonHeldOut']['balancedAccuracy']*100 for m in selected])
base=np.array([m['commonGlobalOffsetBaseline']['balancedAccuracy']*100 for m in selected])
axes[0].plot(x,score,'o-',color='#1269a5',label='セル別の釣合いを推定')
axes[0].plot(x,base,'s--',color='#7a7a7a',label='全域共通の釣合いのみ')
axes[0].axhline(50,color='#999999',linewidth=.8)
for i,s in enumerate(score):
    axes[0].annotate(f'{s:.1f}%',(i,s),xytext=(0,8),textcoords='offset points',ha='center')
axes[0].set_ylim(38,75)
axes[0].set_ylabel('リッチ・リーン各正解率の平均 [%]')
axes[0].set_title(f'別区間のO₂符号予測：全仮定で共通の {d["commonHeldOutBankObservations"]:,} バンク観測')
axes[0].legend(loc='lower right')
rich=np.array([i['focusSourceRich'] for i in d['inventories']])
lean=np.array([i['focusSourceLean'] for i in d['inventories']])
axes[1].bar(x,rich,color='#cf752e',label='リッチ')
axes[1].bar(x,lean,bottom=rich,color='#1269a5',label='リーン')
for i,(r,l) in enumerate(zip(rich,lean)):
    axes[1].text(i,r+l+2,f'{r} / {l}',ha='center')
axes[1].set_ylim(0,180)
axes[1].set_ylabel('延べバンク観測数 [件]')
axes[1].set_title('原因側の運転点を問題領域へ対応づけたO₂：数字はリッチ / リーン')
axes[1].legend(loc='upper right')
for ax in axes:
    ax.set_xticks(x,labels)
    ax.set_xlabel('遅れの仮説（DME定数として確定した値ではない）')
    ax.spines[['top','right']].set_visible(False)
    ax.grid(axis='y',alpha=.2)
    ax.set_axisbelow(True)
fig.suptitle(f'#{d["session"]} 運転点保持なしの過渡同定実験',fontsize=16)
fig.savefig(out/'validation.png',dpi=160)
plt.close(fig)

best=max(m['commonHeldOut']['balancedAccuracy'] for m in models)*100
values=np.expm1(np.array([m['focusNominalLogParameters'] for m in models]))*100
line=[]
def add(s=''):line.append(s)
add(f'#{d["session"]} 過渡ログからのVE同定：検証結果（2026-10-11）')
add('生成器：scripts/render-ve-transient.py。数値を手で変更しない。')
add()
add('判定')
add('運転点保持を求めずに解析することは可能。ただし、今回試したモデルは対象セルのVE修正量を決める検証を通らなかった。')
add('2周期の選別だけで実用性を失う問題と、計測から燃料誤差量を一意に決められない問題の両方がある。')
add('この結果は、通常走行のVEチューニングが原理的に不可能という証明ではない。')
add('旧97セル・新2セルという比較の「新2セル」を、実用的なVE推定器の完成として扱わない。')
add()
add('実施内容')
add(f'・生ログ {d["rawRows"]:,}点と記録BASEを照合。入力に使えた行は仮定により {min(m["rows"] for m in models):,}～{max(m["rows"] for m in models):,}点。採用点数ではなく解析入力数。')
add('・固定rpm/RO幅、2周期の成立、旧Tunerの1秒ゲートは要求しない。読取りの欠測・制御OFF・カウンタリセットを跨いで補間しない。')
add('・STFT、直接rf_korr、BAの読取り時刻を使用。VEセルの寄与は補間重み×元のセル値を正規化する。')
add('・一定遅れ5通り、流量積算による遅れ3通り、記憶項2通り、正則化2通りの計32仮定を比較。正則化はrf_korrの固定αではない。')
add('・流量A/B/C：RF×rpmの積算値で遡る。2000rpm、RF30%で0.25/0.5/1秒相当＋仮のセンサー遅れ0.15秒。実測した遅れではない。')
add('・時系列4群で評価。同一制御区間と両バンクを学習・評価に分けない。評価区間の前後10秒も学習から除く。')
add('・問題の6セルを1パラメータにまとめる場合も検証。細かく分けすぎたことだけでは不安定さを説明できなかった。')
add()
add('予測結果')
add(f'・全32仮定に共通する {d["commonHeldOutBankObservations"]:,} バンク観測で比較。リッチ・リーンの正解率を同じ重みで平均する。')
add(f'・最も良い仮定でも {best:.1f}%。32通りから選んだ後の独立した最終試験成績ではない。AFR誤差率やVE精度でもない。')
add('・下表は記憶項0、正則化1の同条件比較。')
for label,m in zip(labels,selected):
    add(f'  {label:8s}  セル別 {m["commonHeldOut"]["balancedAccuracy"]*100:5.1f}% / 全域共通のみ {m["commonGlobalOffsetBaseline"]["balancedAccuracy"]*100:5.1f}%')
add('・実測STFTを入力としてO₂符号を予測した条件付き検証。変更後のSTFT・空燃比を自律的に予測したものではない。')
add()
add('問題領域 RO7.5～10%、2200～2700rpm')
add(f'・元の運転点で {d["focusRows"]}行、両バンク計 {d["focusRichBankObservations"]}観測がすべてリッチ。リーンは {d["focusLeanBankObservations"]}観測。')
add('・領域内の連続する2点間で観測されたO₂反転は0。領域境界を跨ぐ反転とは区別する。')
for label,i in zip(labels,d['inventories']):
    add(f'  {label:8s}  原因側が領域内の {i["focusSourceRows"]:2d}行 / リッチ {i["focusSourceRich"]:3d} / リーン {i["focusSourceLean"]:2d}')
add('・一定遅れを長く仮定すると領域退出後のリーンが少数対応するが、流量モデルでは今回の領域は片側の観測に留まる。')
add('・仮定・評価に使う区間を変えるとセル推定が大きく変わる。有限の推定値が出ても、それは事前仮定が値を決めている場合がある。')
add()
add('内部パラメータの幅（VEの増減率・推奨値ではない）')
add('以下はrf_korrを含む有効燃料釣合いを説明する exp(beta)-1。現在のRF表を維持したVE書込み倍率とは異なる。')
for i,c in enumerate(d['focusCells']):
    add(f'  RO{c["load"]:g}% / {c["rpm"]}rpm : {values[:,i].min():+.1f}% ～ {values[:,i].max():+.1f}%')
add('これらの幅は信頼区間ではなく、仮定32通りでの感度範囲。大きい値では局所線形近似自体も弱くなる。')
add()
add('DMEロジックとの整合')
add('・slave 01D6A2/01DC42：リッチ中はKiで積分値を減らす。OFFでSTFT=1、I=0、Pカウンタ=0へ戻す。')
add('・既存の実BIN照合では、対象の連続通過11区間のSTFT下降を代表Ki=13で説明できた。ただし、これは空燃比を予測した結果ではない。')
add('・誤差の符号が同じ間は、異なる誤差量でも同じ積分下降を起こし得る。下降速度から誤差率を逆算できない。')
add('・仕様書5.01 p.5は、制御器のTVと、噴射→燃焼→排気→センサーの物理的遅れを区別し、後者の負荷・回転依存を述べる。TVはDMEが把握した全輸送遅れではない。')
add('・master 01A9D2のrf_soll平滑化、0218D0のMAP加算、slave 01B0E2の未記録噴射項まで再現した完全モデルではない。')
add('・MAP積分値が一定であることと、MAP補正・他の噴射補正をすべて分離できたことは同義ではない。')
add()
add('今後の判断')
add('1. 現在の2周期比較を、通常走行向けVEチューニングの完成版として採用しない。今回の試作係数もTuneへ移さない。')
add('2. 移動区間の証拠は捨てずに保持する。片側の符号しかない区間は不等式の制約として扱い、値を一つに決めたように表示しない。')
add('3. 次の観測設計では、最終噴射側の補正とO₂反転時刻の対応を優先する。項目数を増やして通信を遅くするだけの変更は避ける。')
add('4. 対象域に片側観測しか残らない場合、修正量の検証には広帯域λ等の量的観測、または条件を管理した比較試験が必要になる。定常運転の保持は前提にしない。')
add('追加走行・部品購入・ECU変更は、この検証で実施または依頼していない。')
add()
add('検査・再現')
add('python scripts/verify-ve-transient.py：移動する人工軌跡から既知係数を回収／片側観測の非一意性／リセットと欠測の境界／片側評価の表示。全4件PASS。')
add('人工データの成功は数値処理の検査であり、実車の物理モデルが正しい証明ではない。')
add(f'BASE SHA-256: {d["baseSha256"]}')
add(f'log.jsonファイル SHA-256: {d["logFileSha256"]}')
add('BASEは今回のECU読戻しではない。RAM物理対応も未検証。D1・元ログ・ECU・Tune・公開アプリは変更なし。')
add()
add('一次資料')
add('ローカル：archive/d1/2026-10-11-rf-response-analysis/dme-sources/5.01.txt（PDF p.5）、f-slave-01d6a2.txt、f-master-01a9d2.txt、f-master-0218d0.txt。')
add('ローカル：archive/d1/2026-10-10-rf-reset-check/source-f-slave-01b0e2.txt。')
add('Bosch：切替式センサーは理論空燃比付近のリッチ／リーン遷移を検出。')
add('https://www.bosch-mobility.com/en/solutions/exhaust-gas-treatment/switching-type-lambda-sensor/')
add('Bosch：広帯域センサーは広い範囲の空燃比算出に使用。')
add('https://www.bosch-mobility.com/en/solutions/exhaust-gas-treatment/wideband-lambda-sensor/')
(out/'result-ja.txt').write_text('\n'.join(line)+'\n',encoding='utf-8')
print(out/'result-ja.txt')
print(out/'validation.png')
