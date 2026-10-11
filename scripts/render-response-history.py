"""Render private response-history results; does not rerun or select models."""
from pathlib import Path
import argparse
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def render(directory):
    d=json.loads((directory/'analysis.json').read_text(encoding='utf-8'))
    estimated,fuel=d['results']
    scores=[estimated['instant'],estimated['selectedHistory'],fuel['instant'],fuel['selectedHistory']]
    labels=['STFT推定\n同時点','STFT推定\n履歴あり','噴射TI\n同時点','噴射TI\n履歴あり']
    colors=['#aac6d8','#4d7e9c','#f0bc8a','#c76a24']
    plt.rcParams['font.family']='Meiryo'
    fig=plt.figure(figsize=(12,10),layout='constrained')
    gs=fig.add_gridspec(2,2,height_ratios=[1,1.15])
    ax=fig.add_subplot(gs[0,0]);vals=[100*s['balancedAccuracy'] for s in scores]
    bars=ax.bar(labels,vals,color=colors);ax.bar_label(bars,fmt='%.1f%%',padding=4)
    ax.set_ylim(0,80);ax.set_ylabel('濃い側・薄い側の平均正答率 / %');ax.set_title('高いほど良い');ax.grid(axis='y',alpha=.2)
    ax=fig.add_subplot(gs[0,1]);bars=ax.bar(labels,[s['logLoss'] for s in scores],color=colors)
    ax.bar_label(bars,fmt='%.3f',padding=4);ax.set_ylim(0,1);ax.set_ylabel('log loss');ax.set_title('低いほど良い：TI履歴が全指標で優れるわけではない');ax.grid(axis='y',alpha=.2)
    ax=fig.add_subplot(gs[1,:]);ax.axis('off')
    cells=d['focusCellSupport'];rows=[]
    for load in [7.5,10]:
        row=[f'RO {load:g}%']
        for rpm in [2200,2400,2700]:
            c=next(c for c in cells if c['rpm']==rpm and c['load']==load)
            row.append(f"濃 {c.get('rich',0)} / 薄 {c.get('lean',0)}\n{c.get('timeBlocks',0)}つの時間区間に分布")
        rows.append(row)
    table=ax.table(cellText=rows,colLabels=['履歴の寄与先','2200 rpm','2400 rpm','2700 rpm'],cellLoc='center',loc='center',bbox=[0,.24,1,.60])
    table.auto_set_font_size(False);table.set_fontsize(12)
    for (r,c),cell in table.get_celld().items():
        cell.set_edgecolor('#c6cdd3')
        if r==0:cell.set_facecolor('#e4ecf0')
        elif c==0:cell.set_facecolor('#f2f5f7')
    ax.set_title('対象セルへ寄与したO₂観測：現在点だけでは捨てていた情報を履歴へ割り当てる',pad=8)
    ax.text(0,.13,'数値は履歴寄与が1%を超えるbank観測数。VE修正採用数ではなく、各観測・セルは独立でもない。',transform=ax.transAxes,fontsize=10)
    ax.text(0,.045,'修正倍率は正則化で大きく変わる。今回の結果からBINへ書き込める修正量は確定していない。',transform=ax.transAxes,fontsize=11,color='#9e321e')
    fig.suptitle(f"Session #{d['session']}：通過中の噴射履歴を使った検証\n{d['rawRows']:,}点中{d['commonRows']:,}点・{d['commonBankObservations']:,} bank観測、同一集合で時系列の二重交差検証",fontsize=14)
    fig.savefig(directory/'comparison.png',dpi=155)

    lines=[f"Session #{d['session']}：噴射履歴とO₂応答の検証結果",'',
        '実装した内容',
        '・最終噴射指令とモデル空気量を各読取り時刻へ置き、通過中の履歴を計算する。',
        '・TIにSTFT・BA・rf_korrを二重に掛けない。λ OFFでも物理履歴を消さず、実カット状態を区別する。',
        '・固定遅れ、空気流量に応じた移動、混合、燃料貯留の13仮説を比較する。',
        '・検証対象の区間を見ず、学習区間内で仮説を選ぶ。運転点保持は条件にしない。','',
        f"使用データ：{d['rawRows']}点中{d['commonRows']}点（{d['commonRows']/d['rawRows']:.1%}）、{d['commonBankObservations']} bank観測。",'',
        '比較（濃薄の平均正答率 / log loss）']
    for label,score in zip(labels,scores):lines.append(f"{label.replace(chr(10),'・')}：{score['balancedAccuracy']:.2%} / {score['logLoss']:.4f}")
    lines += ['',
        '履歴を使う効果は、未学習区間でも確認できた。',
        'TI履歴はSTFT履歴より平均正答率が高いが、log lossは悪化する。全指標で優れると評価しない。',
        '計測時刻を読取り開始／終了へ動かし、カットの切替を早期／後期へ動かしても、TI履歴の平均正答率は次の範囲だった。']
    for c in d['timingSensitivity']:lines.append(f"{c['scenario']}：{c['metrics']['balancedAccuracy']:.2%}（同一観測で比較）")
    lines += ['',
        '対象セルへの情報',
        '対象範囲内の現在点だけでなく、隣接点の補間寄与と輸送された履歴を評価できる。',
        '以下は履歴の寄与重みが1%を超えるbank観測数。点数をVE採用数に読み替えてはならない。']
    for c in cells:lines.append(f"RO {c['load']:g}% / {c['rpm']} rpm：濃 {c.get('rich',0)}、薄 {c.get('lean',0)}")
    strong=fuel['strongerPriorSensitivity']['metrics']
    lines += ['',
        'まだVE書換えへつなげられない具体的な理由',
        f"正則化を10倍へ変えたTI履歴の平均正答率は{strong['balancedAccuracy']:.2%}。次の内部推定倍率の変化と対比する。"]
    example=next((c for c in cells if c['rpm']==2200 and c['load']==7.5 and 'foldLogFactors' in c),None)
    if example:
        weak=np.exp(example['foldLogFactors']);strong_factor=np.exp(example['strongerPriorFoldLogFactors'])
        lines.append(f'例：RO 7.5% / 2200 rpmの内部倍率は通常設定{weak.min():.3f}〜{weak.max():.3f}、強い正則化では{strong_factor.min():.3f}〜{strong_factor.max():.3f}。')
    lines += ['この数字はVEの推奨倍率ではない。量が事前仮定に依存することを確認する診断値。']
    one_sided=[f"RO {c['load']:g}% / {c['rpm']} rpm" for c in cells if c.get('observations',0)>0 and (c.get('lean',0)==0 or c.get('rich',0)==0)]
    if one_sided:lines.append('片側の寄与観測しかないセル：'+'、'.join(one_sided)+'。データだけで両側の境界を決められない。')
    lines += [
        'また、TLへ至るRFのPT1やMAP加算の変化をVEセルの変更として完全に再現していない。',
        'よって、このモデルの有効空気誤差をそのままVEテーブルへ書く処理は作っていない。','',
        'サンプリングで見えていない制御']
    for c in d['controllerSampling']:lines.append(f"bank {c['bank']}：{c['intervals']}隣接区間のうち{c['multiplePSteps']}区間でP回数が2以上進む。うち{c['sameO2SideWithMultiplePSteps']}区間はO₂の両端が同じ側。")
    lines += ['これはサンプル間のDME動作を全て記録できていない証拠。予測誤差の全てがこれに由来するという断定ではない。','',
        '成果と残る課題',
        '通常走行の情報を大量に捨てる判定から、通過履歴を使ってO₂応答を評価する処理へ進めた。',
        '残る課題は、予測できる有効誤差を実際のVEセルの変更量へ結びつけること。固定αや待ち時間の調整では解決しない。',
        '現行Tune、ECU、D1へ変更はしていない。今回実装したのは保存ログに対する再現可能な検証エンジン。','',
        '再現：npm run analyze:response-history -- <取得済みセッションディレクトリ>',
        '検査：npm run verify:response-history',
        '詳細：analysis.json、predictions.json、comparison.png']
    (directory/'report-ja.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path)
    render(parser.parse_args().directory.resolve())
