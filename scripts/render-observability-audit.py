"""Render independent audits; no model selection, calibration or ECU writes."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT=Path(__file__).resolve().parents[1]


def render(sid,nominal=False):
    read=lambda folder:json.loads((ROOT/'archive'/folder/sid/'analysis.json').read_text(encoding='utf-8'))
    air=read('dme-air-path');profile=read('nominal-response-profile' if nominal else 'response-profile')
    switch=read('nominal-switch-constraints' if nominal else 'switch-constraints');cut=read('cut-response')
    recording=read('recording-audit') if nominal else None
    if len({r['baseSha256'] for r in [air,profile,switch,cut]})!=1 or len({r['logFileSha256'] for r in [air,profile,switch,cut]})!=1:
        raise ValueError('Audit inputs differ')
    plt.rcParams.update({'font.family':'Yu Gothic','axes.unicode_minus':False,'font.size':11})
    fig,axes=plt.subplots(2,2,figsize=(15,10),constrained_layout=True)
    fig.suptitle(f"Session #{air['session']} — 修正量が決まるかの検証"+('（rf_soll基準）' if nominal else '（適用後TL基準）'),fontsize=20,fontweight='bold')
    names=[];intervals=[];counts=[]
    for load in [7.5,10]:
        for rpm in [2200,2400,2700]:
            names.append(f'RO {load:g}% / {rpm}')
            values=[c for s in switch['scenarios'] for c in s['cells'] if c['rpm']==rpm and c['load']==load]
            factors=[c['factor'] for c in values if c['factor'] is not None]
            intervals.append([min(factors),max(factors)] if factors else [np.nan,np.nan])
            counts.append([min(c['count'] for c in values),max(c['count'] for c in values)])
    ax=axes[0,0]
    for i,((lo,hi),(nlo,nhi)) in enumerate(zip(intervals,counts)):
        if np.isfinite(lo):
            ax.plot([lo,hi],[i,i],lw=8,solid_capstyle='round',color='#347cad')
            ax.text(hi+.025,i,f'{lo:.2f}–{hi:.2f}',va='center',fontsize=10)
        else:ax.text(.55,i,'切替の寄与なし',va='center',color='#ad4c35')
    ax.axvline(1,color='#777',ls='--',lw=1);ax.set_yticks(range(6),names);ax.invert_yaxis()
    ax.set_xlim(.25,1.65);ax.set_xlabel('有効空気モデル倍率（VEの書込み倍率ではない）')
    ax.set_title('切替時刻・輸送遅れ・事前仮定を変えた推定範囲\n信頼区間ではない。広さはモデルへの依存を示す',fontsize=12)
    ax=axes[0,1]
    table=ax.table(cellText=[[n,f'{lo}–{hi}'] for n,(lo,hi) in zip(names,counts)],
        colLabels=['対象セル','寄与するO₂切替の数'],cellLoc='center',loc='center')
    table.auto_set_font_size(False);table.set_fontsize(12);table.scale(1,2)
    ax.axis('off');ax.set_title(f"全走行から共通に使えた切替：{switch['commonCrossings']:,}件\n運転点保持・同じセルで2周期という条件は課していない",fontsize=12)
    ax=axes[1,0]
    for cell,color in zip(profile['cells'][:3],['#347cad','#c85835','#429569']):
        ax.plot([v['factor'] for v in cell['factors']],[v['local']['logLoss'] for v in cell['factors']],
                marker='o',color=color,label=f"RO7.5% / {cell['rpm']}rpm")
    ax.set_xlabel('固定して再計算した有効空気モデル倍率');ax.set_ylabel('対象セルに寄与する観測の検証 log loss')
    ax.set_title('隣接セルを再学習しても説明できるか\n小さいほど良い。検証区間のデータで学習しない',fontsize=12)
    ax.legend(fontsize=10);ax.grid(alpha=.2)
    ax=axes[1,1];ax.axis('off')
    rise=air['segmentFilter']['focusRegionRise95Seconds']['quantiles']
    text=(f"DMEと保存BINから確認したこと\n\n"
          f"• TLとRFの換算式：全{air['rows']:,}点で一致\n"
          f"  TLは独立した空気量センサーではない\n\n"
          f"• rf_soll上昇の95%応答：概算 {rise['p0']*1000:.0f}–{rise['p100']*1000:.0f} ms\n"
          f"  2200–2700rpm。秒単位の待ちではない\n\n"
          f"• DKBA追加噴射：保存BINの両テーブルが全0\n\n"
          f"• カットとO₂切替の前後関係を読取り窓から\n"
          f"  分離できた例：{cut['summary']['orderResolved']}件\n"
          f"  ここから厳密な輸送遅れを決めない\n\n"
          f"結論：VE各セルの修正量は未確定。\n"
          f"この推定範囲をVEへ書き込む根拠にはしない。")
    ax.text(0,1,text,va='top',fontsize=13,linespacing=1.5)
    out=ROOT/'archive'/('nominal-observability' if nominal else 'observability-audit')/sid;out.mkdir(parents=True,exist_ok=True)
    fig.savefig(out/'comparison.png',dpi=150);plt.close(fig)
    lines=[f"Session #{air['session']}：DMEと既存ログでの修正量の識別性検証",'',
        '実行したこと：DME空気計算の照合、セル固定再推定、単発O2切替による制約、燃料カットの時刻区間検証。',
        '固定α・運転点保持・同じセルで2周期を観測する条件は導入していない。',
        'D1の直近一覧も再取得し、最新の保存ログが#968であることを確認した。','',
        '確認結果',
        f"・TL=floor(9739×RF_raw/2000)/1000 ms が全{air['rows']}点で一致。",
        '・rf_sollの係数は新入力の重みである。表示上の0.070は旧値の残留率で、秒数ではない。',
        f"・6気筒のセグメント周期による2200–2700rpmの95%ステップ応答は概算{rise['p0']*1000:.1f}〜{rise['p100']*1000:.1f}ms。",
        '  これは保存BINと観測RFによる計算で、実車の未観測入力まで再現した測定値ではない。',
        '・DKBAのSOFT/HARDテーブルは全0。保存BINに従う限り、この追加噴射を主因とする根拠はない。',
        '・O2切替の正確な時刻USV1/2_WECHSEL_TIMEはslave FFD912/FFD91C。現在の通常RAM読取りでは取得できない。',
        '・DMEの濃い側の積分減量はO2が濃いこととBINのKiで決まる。濃さの量を逆算できる制御ではない。','',
        f"単発切替による検証：{switch['observedCrossings']}件抽出、全シナリオに共通する{switch['commonCrossings']}件を使用。",
        '切替区間の開始/中点/終了、遅れ0/.25/.5/1秒、事前仮定3通り。',
        '下表は有効空気モデルの倍率の感度範囲。信頼区間やVE書込み推奨値ではない。']
    for name,(lo,hi),(nlo,nhi) in zip(names,intervals,counts):
        lines.append(f"  {name}：切替寄与{nlo}〜{nhi}件、倍率"+(f"{lo:.3f}〜{hi:.3f}" if np.isfinite(lo) else '未観測'))
    if recording:
        proof=recording['historicalCalibration'];m=recording['rfArithmetic']
        lines += ['', '前の判定の訂正',
            f"・#{proof['sourceSeq']}の実書込みを再構成し、記録SHA-256 {proof['sha256']} と完全一致。",
            '・保存BASEのk_rf_cfg=0x12を実車の設定と扱ったのは誤り。記録された書込みは0x02、MAP補正停止・学習停止・パージ停止。',
            f"・時刻を揃えて比較できる{m['comparablePoints']}点中{m['noMapBetter']}点で、RF=rf_soll×rf_korrの方がMAP保存値を加えた式よりよく一致。",
            '・MAP積分の保存値が非ゼロでも、その値を噴射へ適用しているとは限らない。',
            f"・全セル保留は訂正。応答方式の比較候補は全体{recording['responseAcceptedCells']}セル。ただし対象6セルには候補なし。",
            '・今回の履歴モデルは適用前rf_sollを空気基準にし、適用後の実測TIを燃料側に置いた。rf_korrをTIへ再乗算しない。',
            '・この履歴確認は当時の実車全バイト読戻しではない。後続の未記録書込みがないという前提は明示する。']
    lines += ['',
        '判定：現ログは全セルの修正量を一意に決めない。特にRO10%/2200rpmは切替制約がなく、',
        'このセルの数値を出すには、ログ以外の仮定で値を補う必要がある。事前仮定や固定αで補った値を実測と呼ばない。',
        'RO7.5%/2400rpmの減らす方向は今回試したモデルで共通するが、量と公称VEへの変換は未確定。','',
        '次の計測を成立させるための仕様',
        '1. ログ開始時にECUのチェックサム2値を読み、SHA検証済みの保存BINと照合してログに同梱する。対応するBINがなければ全BINをREADする。',
        '2. 優先する追加情報は時刻付きの実測lambda。センサーの機種、bank/設置位置、正常・暖機状態、時刻系を保存する。',
        '   AFRしか出ない場合は機器の設定stoichiometric AFRも記録し、固定14.7と決め付けて換算しない。',
        '3. 追加loggerとDMEの時刻を共通時計にするか、開始/終了を含む複数の同期点でclock offset/driftを測る。',
        '   時計のずれと排気の輸送遅れは別々に扱う。O2を最もよく予測する遅れへ無条件に合わせない。',
        '4. 通常の加減速で対象領域を通過する。運転点保持・全開走行・再リセットは条件にしない。',
        '5. DMEには今回のTI、blanking、BA、lambda状態、STFT、RF、rf_soll、rf_korrと各読取り窓を残す。',
        '   高速の外部lambdaだけでDMEの読取り間の空白が消えるわけではない。時刻の幅を振ってセル量が再現するか検証する。',
        '6. 外部lambdaが無い場合は、異なる既知校正で同じ領域を通過し、濃薄切替を挟む比較実験が代案。',
        '   そのBIN差分・比較範囲は現在の読戻しBINを根拠に作成する必要があり、未検証の修正BINは生成していない。',
        '同じ設定のまま同じ濃い側だけを追加記録しても、修正量の下限/上限の両方が得られる保証はない。','',
        '保存先：archive/dme-air-path、response-profile、switch-constraints、cut-response。',
        '解析は修正TuneのBINを生成しない。ログ開始時の参照BINの保存・再読込を実装した。',
        '修正量の確定と実車検証は未完了。']
    (out/'report-ja.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(out)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('session_id');p.add_argument('--nominal',action='store_true')
    args=p.parse_args();render(args.session_id,args.nominal)
