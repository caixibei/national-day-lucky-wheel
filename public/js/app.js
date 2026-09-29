'use strict';

/**
 * 国庆大转盘 H5 主逻辑：会话恢复、转盘绘制与旋转动画、抽奖与邮件重发交互。
 * 结果判定一律以服务端返回为准，前端动画仅为结果的表现层；并发防护由 spinning 状态位保证。
 */
(() => {
  const state = {
    email: null,
    activity: null,
    remaining: null,
    spinning: false,
    rot: 0, // 转盘累计旋转角度（度），跨次抽奖累加，保证每次动画方向连续
    images: new Map(), // 已加载的奖品图片缓存（prizeId -> Image）
  };
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 转盘动画：默认约 6 圈、4.2~5 秒（每次随机时长防机械感）；reduced-motion 用户降为 1 圈快停
  const SPIN_TURNS = REDUCED ? 1 : 6;
  const SPIN_MS = REDUCED ? 1200 : 4200 + Math.floor(Math.random() * 800);

  const $ = (id) => document.getElementById(id);
  const canvas = $('wheelCanvas');
  const ctx = canvas.getContext('2d');

  // 与服务端同口径的简化邮箱校验：先拦一层明显格式错误，减少无效请求
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

  // 幂等键生成：secure context 提供 crypto.randomUUID；局域网 http 调试等非安全上下文降级随机串
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // API 前缀：由当前页面所在目录推导——根部署为 ''，子路径部署（如 /lucky-wheel/）自动带前缀，
  // 与服务端 BASE_PATH 挂载对齐；页面前端资产同样使用相对路径，两种部署方式共用一套代码
  const API_PREFIX = new URL('.', location.href).pathname.replace(/\/+$/, '');

  // —— 接口封装：4xx 展示后端业务提示，5xx 提示稍后再试，网络异常提示离线；写操作不自动重试 ——
  async function api(url, options = {}) {
    let res;
    try {
      res = await fetch(API_PREFIX + url, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'same-origin',
      });
    } catch (e) {
      throw new Error('网络异常，请检查连接后重试');
    }
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* 空响应体按无数据处理 */
    }
    if (!res.ok) throw new Error(data.message || (res.status >= 500 ? '服务繁忙，请稍后再试' : '请求失败，请重试'));
    return data;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  function show(id) {
    $(id).hidden = false;
  }
  function hide(id) {
    $(id).hidden = true;
  }

  // 外环灯珠：12 颗由 JS 生成，均匀分布与闪烁节奏由 CSS 控制
  function buildLamps() {
    const ring = $('wheelRing');
    for (let i = 0; i < 12; i++) {
      const lamp = document.createElement('span');
      lamp.className = 'lamp';
      ring.appendChild(lamp);
    }
  }

  // —— 转盘绘制：扇区 i 从正上方起顺时针排布，与服务端 segmentIndex 约定一致 ——
  // 扇区配色为 [内缘色, 外缘色] 的径向渐变对：内亮外深叠出盘面立体感，配金色描边
  const SECTOR_FILL = [
    ['#ea5a4c', '#c81f1f'],
    ['#fffdf4', '#ffe2a6'],
  ];
  const TEXT_COLORS = ['#FFF6E5', '#A31621'];

  function setupCanvas() {
    const size = canvas.parentElement.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawWheel() {
    const prizes = state.activity ? state.activity.prizes : [];
    const n = prizes.length;
    if (!n) return;
    const size = canvas.clientWidth;
    const c = size / 2;
    const r = c - 4;
    const arc = (Math.PI * 2) / n;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((state.rot * Math.PI) / 180);
    prizes.forEach((p, i) => {
      const start = -Math.PI / 2 + i * arc;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, start, start + arc);
      ctx.closePath();
      // 径向渐变填充：圆心处取内缘亮色、盘缘取外缘深色，形成受光立体感
      const grad = ctx.createRadialGradient(0, 0, r * 0.12, 0, 0, r);
      grad.addColorStop(0, SECTOR_FILL[i % 2][0]);
      grad.addColorStop(1, SECTOR_FILL[i % 2][1]);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#F7C948';
      ctx.stroke();

      // 扇区文字：沿中线切向排布；中线落在左半盘（90°~270°）时补转 180° 修正，
      // 保证任何扇区位置的文字都正向可读（修复旧版左侧扇区文字倒置问题）
      ctx.save();
      const midRad = start + arc / 2;
      ctx.rotate(midRad);
      const midDeg = (((midRad * 180) / Math.PI) % 360 + 360) % 360;
      const flip = midDeg > 90 && midDeg <= 270;
      if (flip) ctx.rotate(Math.PI);
      const dist = r * 0.62;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const img = state.images.get(p.id);
      let hasImg = false;
      if (img && img.complete && img.naturalWidth) {
        const d = Math.min(40, r * 0.24);
        ctx.drawImage(img, (flip ? -1 : 1) * r * 0.5 - d / 2, -d / 2, d, d);
        hasImg = true;
      }
      const label = String(p.name || '');
      // 字号自适应：以中线处扇区弧宽的 82% 为宽度上限，长名自动缩小避免溢出扇区
      const maxW = ((2 * Math.PI * dist) / n) * 0.82;
      const fontSize = Math.max(10, Math.min(18, Math.floor(maxW / Math.max(1, label.length))));
      ctx.font = `bold ${fontSize}px 'PingFang SC','Microsoft YaHei',sans-serif`;
      const textY = hasImg ? r * 0.3 : 0;
      const textX = flip ? -dist : dist;
      // 双层描字：先画 1.5px 偏移的深色底层再画主色，模拟投影提升可读性
      ctx.fillStyle = 'rgba(90, 10, 16, 0.35)';
      ctx.fillText(label, textX, textY + 1.5);
      ctx.fillStyle = TEXT_COLORS[i % 2];
      ctx.fillText(label, textX, textY);
      ctx.restore();
    });
    ctx.restore();
  }

  function preloadImages() {
    const prizes = state.activity ? state.activity.prizes : [];
    prizes.forEach((p) => {
      if (!p.image || state.images.has(p.id)) return;
      const img = new Image();
      img.onload = () => drawWheel();
      img.src = p.image;
      state.images.set(p.id, img);
    });
  }

  // —— 旋转动画：扇区 i 中线角 = -90° + (i+0.5)·seg，停点需满足「中线角 + 累计旋转 ≡ -90°（mod 360）」，
  //    即目标扇区中线对准指针（正上方）；叠加整圈数与扇区内 70% 宽度的随机偏移，停点随机且不越过扇区边界 ——
  function spinTo(segmentIndex) {
    return new Promise((resolve) => {
      const n = state.activity.prizes.length;
      const seg = 360 / n;
      const jitter = (Math.random() - 0.5) * seg * 0.7;
      const finalMod = (((-(segmentIndex + 0.5) * seg + jitter) % 360) + 360) % 360;
      const currentMod = ((state.rot % 360) + 360) % 360;
      const delta = (((finalMod - currentMod) % 360) + 360) % 360;
      const from = state.rot;
      const to = state.rot + SPIN_TURNS * 360 + delta;
      const start = performance.now();
      function frame(t) {
        const p = Math.min(1, (t - start) / SPIN_MS);
        const ease = 1 - Math.pow(1 - p, 3); // easeOutCubic：先快后慢，模拟真实转盘减速
        state.rot = from + (to - from) * ease;
        drawWheel();
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function remainingLeft() {
    if (!state.remaining) return 0;
    // 每日与活动总计两条限额取较小值：任一用尽即不可抽
    return Math.min(state.remaining.daily, state.remaining.total);
  }
  function updateRemaining() {
    $('remainingNum').textContent = String(remainingLeft());
  }

  // —— 抽奖流程：先请求服务端拿结果（限次/频控/黑名单在服务端校验），拿到结果再播动画，动画结束弹窗 ——
  async function onSpin() {
    if (state.spinning) return;
    if (!state.activity || state.activity.status !== 'published') {
      toast('活动未开始或已结束');
      return;
    }
    if (remainingLeft() <= 0) {
      toast('您的抽奖次数已用完');
      return;
    }
    state.spinning = true;
    $('spinBtn').disabled = true;
    $('wheelRing').classList.add('spinning');
    try {
      const data = await api('/api/draw', { method: 'POST', body: { requestId: uuid() } });
      state.remaining = data.remaining || state.remaining;
      updateRemaining();
      await spinTo(data.segmentIndex);
      showResult(data);
    } catch (e) {
      toast(e.message);
    } finally {
      state.spinning = false;
      $('spinBtn').disabled = false;
      $('wheelRing').classList.remove('spinning');
    }
  }

  // 结果弹窗：中奖展示奖品/兑奖码/邮件状态，未成功发送时提供重发入口
  function showResult(data) {
    if (data.isWin) {
      $('resultPrize').textContent = data.prizeName;
      $('resultCode').textContent = data.prizeCode || '';
      const resend = $('resendBtn');
      resend.dataset.recordId = data.recordId;
      resend.hidden = true;
      updateMailText(data.mailStatus);
      $('resultLose').hidden = true;
      $('resultWin').hidden = false;
      launchConfetti();
    } else {
      $('resultWin').hidden = true;
      $('resultLose').hidden = false;
    }
    show('modalResult');
  }

  // 邮件状态 → 用户文案：failed 必须给出路（重发），simulated 如实告知未真实发送
  function updateMailText(mailStatus) {
    const mail = $('resultMail');
    const resend = $('resendBtn');
    resend.hidden = mailStatus === 'sent' || mailStatus == null;
    if (mailStatus === 'pending') mail.textContent = `奖品邮件正在发送至 ${state.email}，请留意收件箱与垃圾邮件`;
    else if (mailStatus === 'sent') mail.textContent = `邮件已发送至 ${state.email}，请查收（留意垃圾邮件）`;
    else if (mailStatus === 'simulated') mail.textContent = '（演练模式）邮件未实际发送，请妥善保存兑奖码';
    else if (mailStatus === 'failed') mail.textContent = '中奖邮件发送失败，可点击下方按钮重发';
    else mail.textContent = `奖品将发送至 ${state.email}，请留意收件箱`;
  }

  // —— 复制兑奖码：clipboard API 仅在 secure context 可用，降级 execCommand 兜底 ——
  async function copyCode() {
    const code = $('resultCode').textContent;
    try {
      await navigator.clipboard.writeText(code);
      toast('兑奖码已复制');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('兑奖码已复制');
    }
  }

  // 彩带：中奖时撒落一次，节点动画结束后自动清理，避免长活动页面节点堆积
  function launchConfetti() {
    const box = $('confetti');
    const colors = ['#D42A2A', '#F7C948', '#D9A421', '#FFF3D6', '#A31621'];
    for (let i = 0; i < 28; i++) {
      const piece = document.createElement('i');
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = Math.random() * 0.6 + 's';
      box.appendChild(piece);
      setTimeout(() => piece.remove(), 3400);
    }
  }

  // —— 我的奖品：渲染本人记录；中奖行按邮件状态打标，失败态可重发 ——
  async function openRecords() {
    try {
      const data = await api('/api/records');
      const box = $('recordsList');
      box.textContent = '';
      if (!data.list.length) {
        const empty = document.createElement('p');
        empty.className = 'lw-empty';
        empty.textContent = '还没有抽奖记录，快去转一转吧！';
        box.appendChild(empty);
        return show('modalRecords');
      }
      const chipText = { sent: '已发送', pending: '发送中', failed: '发送失败', simulated: '演练' };
      data.list.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'lw-record-row';
        const info = document.createElement('div');
        info.className = 'lw-record-info';
        const name = document.createElement('b');
        name.textContent = r.is_win ? r.prize_name : '谢谢参与';
        const time = document.createElement('span');
        time.textContent = r.drawn_at;
        info.append(name, time);
        const side = document.createElement('div');
        side.className = 'lw-record-side';
        if (r.is_win) {
          const chip = document.createElement('span');
          chip.className = 'lw-chip lw-chip-' + (r.mail_status || 'pending');
          chip.textContent = chipText[r.mail_status] || '发送中';
          side.appendChild(chip);
          if (r.prize_code) {
            const code = document.createElement('span');
            code.className = 'lw-record-code';
            code.textContent = r.prize_code;
            side.appendChild(code);
          }
          // 未成功送达的记录提供重发按钮；sent 状态不重复发送
          if (r.mail_status !== 'sent') {
            const btn = document.createElement('button');
            btn.className = 'lw-btn lw-btn-mini';
            btn.textContent = '重发';
            btn.dataset.recordId = r.id;
            side.appendChild(btn);
          }
        }
        row.append(info, side);
        box.appendChild(row);
      });
      show('modalRecords');
    } catch (e) {
      toast(e.message);
    }
  }

  // 活动规则：由活动配置动态生成，邮箱正确性提示固定强调（奖品发放依赖）
  function openRules() {
    const a = state.activity;
    const box = $('rulesBody');
    box.textContent = '';
    const items = a
      ? [
          `活动时间：${a.startTime} 至 ${a.endTime}`,
          `每人每日可抽 ${a.dailyLimit} 次，活动期内累计 ${a.totalLimit} 次`,
          '奖品通过邮件发放至您填写的邮箱，请确保邮箱正确；未收到请检查垃圾邮件或在「我的奖品」中重发',
          '兑奖码是领取奖品的唯一凭证，请妥善保存',
          '系统限制同一设备与同一 IP 的参与频率，请勿使用脚本刷奖，违者将被取消资格',
        ]
      : ['活动暂未配置'];
    const ul = document.createElement('ul');
    ul.className = 'lw-rules';
    items.forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    box.appendChild(ul);
    show('modalRules');
  }

  // —— 屏幕流转 ——
  function enterWheel() {
    $('wheelTitle').textContent = state.activity ? state.activity.name : '国庆大转盘';
    updateRemaining();
    hide('screen-gate');
    show('screen-wheel');
    setupCanvas();
    drawWheel();
  }

  function showGate(notice) {
    show('screen-gate');
    hide('screen-wheel');
    if (notice) {
      const n = $('gateNotice');
      n.textContent = notice;
      n.hidden = false;
    }
  }

  async function onEnter() {
    const email = $('emailInput').value.trim();
    if (!EMAIL_RE.test(email)) {
      toast('请填写正确的邮箱地址，奖品将通过邮件发送至该邮箱');
      return;
    }
    const btn = $('enterBtn');
    btn.disabled = true;
    try {
      const data = await api('/api/player', { method: 'POST', body: { email } });
      state.email = data.email;
      state.activity = data.activity;
      state.remaining = data.remaining;
      preloadImages();
      enterWheel();
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function init() {
    buildLamps();
    $('enterBtn').addEventListener('click', onEnter);
    $('emailInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onEnter();
    });
    $('spinBtn').addEventListener('click', onSpin);
    $('recordsBtn').addEventListener('click', openRecords);
    $('rulesBtn').addEventListener('click', openRules);
    $('copyCodeBtn').addEventListener('click', copyCode);
    window.addEventListener('resize', () => {
      setupCanvas();
      drawWheel();
    });

    // 弹窗关闭与「重发」统一事件委托：关闭按钮走 data-close，重发按钮自带 data-record-id
    document.addEventListener('click', async (e) => {
      const closer = e.target.closest('[data-close]');
      if (closer) {
        hide(closer.dataset.close);
        return;
      }
      const resender = e.target.closest('[data-record-id]');
      if (resender) {
        const recordId = Number(resender.dataset.recordId);
        resender.disabled = true;
        try {
          const data = await api('/api/resend', { method: 'POST', body: { recordId } });
          toast(data.message || '已提交处理');
          // 列表内重发后刷新列表状态；结果弹窗内重发后按最新状态更新文案
          if (!$('modalRecords').hidden) openRecords();
          if (!$('modalResult').hidden) updateMailText(data.mailStatus);
        } catch (err) {
          toast(err.message);
          resender.disabled = false;
        }
      }
    });

    // 活动信息全局加载：未发布/已结束在邮箱门提示，但仍允许进入查看记录（服务端兜底拒绝抽奖）
    try {
      const data = await api('/api/activity');
      state.activity = data.activity;
      preloadImages();
    } catch (e) {
      showGate('活动加载失败，请稍后刷新重试');
      return;
    }
    const statusNotice = !state.activity
      ? '活动暂未配置，请联系组织者'
      : state.activity.status === 'published'
        ? ''
        : state.activity.status === 'draft'
          ? '活动尚未开始'
          : '活动已结束';

    // 老用户会话恢复：Cookie 有效则直接进入转盘页，免重复填写邮箱
    try {
      const me = await api('/api/me');
      state.email = me.email;
      state.activity = me.activity;
      state.remaining = me.remaining;
      preloadImages();
      enterWheel();
      return;
    } catch (e) {
      /* 无有效会话：展示邮箱门 */
    }
    showGate(statusNotice || undefined);
  }

  init();
})();
