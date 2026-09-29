'use strict';

/**
 * 管理后台单页逻辑：登录会话、活动配置、奖品 CRUD、参与者管理（IP 查询/黑名单/备注/详情）、
 * 抽奖记录查询与导出、中奖邮件重发。查询/重置/分页/导出共用同一筛选对象，保证口径一致。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { playersPage: 1, recordsPage: 1, prizes: [] };

  // —— 接口封装：401 统一回到登录页，其余错误 toast 后端业务文案 ——
  async function api(url, options = {}) {
    let res;
    try {
      res = await fetch(url, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'same-origin',
      });
    } catch (e) {
      throw new Error('网络异常，请检查连接');
    }
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* 空响应体按无数据处理 */
    }
    if (res.status === 401) {
      showLogin();
      throw new Error(data.message || '请先登录');
    }
    if (!res.ok) throw new Error(data.message || '请求失败');
    return data;
  }

  // HTML 转义：奖品名/备注/邮箱等含用户可控内容，统一转义防 XSS
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // IP 展示：本机回环地址（::1 / 127.0.0.1）标注「本机」，避免后台出现无指向的裸回环值；
  // 真实访客 IP 需公网部署（TRUST_PROXY=true）后才会采集到
  function ipLabel(ip) {
    if (!ip) return '—';
    return ip === '::1' || ip === '127.0.0.1' ? `${ip}（本机）` : ip;
  }

  // 设备类型与邮件状态中文映射：列表与详情统一口径
  const DEVICE_LABELS = { mobile: '手机', pc: '电脑', tablet: '平板' };
  const MAIL_STATUS_LABELS = { pending: '待发送', sent: '已发送', failed: '发送失败', simulated: '演练' };
  function deviceLabel(dt) {
    return dt ? DEVICE_LABELS[dt] || dt : '—';
  }
  function mailLabel(st) {
    return st ? MAIL_STATUS_LABELS[st] || st : '—';
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('admToast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  function showLogin() {
    $('loginView').hidden = false;
    $('appView').hidden = true;
  }
  function showApp(username) {
    $('loginView').hidden = true;
    $('appView').hidden = false;
    $('adminName').textContent = username;
  }

  // datetime-local 控件值与服务端 'YYYY-MM-DD HH:MM' 格式互转
  const toInput = (s) => String(s || '').slice(0, 16).replace(' ', 'T');
  const fromInput = (s) => String(s || '').replace('T', ' ');

  // —— Tab 切换：每次切换重查当前筛选，保证切换后数据新鲜 ——
  function switchTab(name) {
    document.querySelectorAll('.adm-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['activity', 'prizes', 'players', 'records'].forEach((n) => {
      $('tab-' + n).hidden = n !== name;
    });
    if (name === 'activity') loadActivity();
    if (name === 'prizes') loadPrizes();
    if (name === 'players') loadPlayers();
    if (name === 'records') {
      loadPrizeOptions();
      loadRecords();
    }
  }

  // —— 活动配置 ——
  async function loadActivity() {
    try {
      const { activity } = await api('/api/admin/activity');
      if (activity) {
        $('actName').value = activity.name;
        $('actStart').value = toInput(activity.start_time);
        $('actEnd').value = toInput(activity.end_time);
        $('actDaily').value = activity.daily_limit;
        $('actTotal').value = activity.total_limit;
        $('actStatus').value = activity.status;
      }
    } catch (e) {
      toast(e.message);
    }
  }

  // statusOverride 用于「发布/关闭」快捷按钮：保存当前表单并直接改状态
  async function saveActivity(statusOverride) {
    const body = {
      name: $('actName').value,
      start_time: fromInput($('actStart').value),
      end_time: fromInput($('actEnd').value),
      daily_limit: Number($('actDaily').value),
      total_limit: Number($('actTotal').value),
      status: statusOverride || $('actStatus').value,
    };
    try {
      await api('/api/admin/activity', { method: 'PUT', body });
      toast('活动配置已保存');
      loadActivity();
    } catch (e) {
      toast(e.message);
    }
  }

  // —— 奖品管理 ——
  async function loadPrizes() {
    try {
      const { list } = await api('/api/admin/prizes');
      state.prizes = list;
      $('prizeTbody').innerHTML =
        list
          .map(
            (p) => `
        <tr>
          <td>${esc(p.sort)}</td>
          <td>${esc(p.name)}${p.type === 'none' ? ' <span class="adm-tag">谢谢参与</span>' : ''}</td>
          <td>${esc(p.weight)}</td>
          <td>${p.stock === -1 ? '不限' : esc(p.stock) + ' / 剩 ' + esc(p.remaining)}</td>
          <td>${p.enabled ? '<span class="adm-tag adm-tag-ok">启用</span>' : '<span class="adm-tag">停用</span>'}</td>
          <td>
            <button class="adm-btn adm-btn-mini" data-prize-edit="${p.id}">编辑</button>
            <button class="adm-btn adm-btn-mini" data-prize-toggle="${p.id}">${p.enabled ? '停用' : '启用'}</button>
            <button class="adm-btn adm-btn-mini adm-btn-danger" data-prize-del="${p.id}">删除</button>
          </td>
        </tr>`
          )
          .join('') || '<tr><td colspan="6" class="adm-empty">暂无奖品，点击「新增奖品」创建</td></tr>';
    } catch (e) {
      toast(e.message);
    }
  }

  function openPrizeDialog(prize) {
    $('prizeDialogTitle').textContent = prize ? '编辑奖品' : '新增奖品';
    $('prizeId').value = prize ? prize.id : '';
    $('prizeName').value = prize ? prize.name : '';
    $('prizeType').value = prize ? prize.type : 'virtual';
    $('prizeWeight').value = prize ? prize.weight : 10;
    $('prizeStock').value = prize ? prize.stock : -1;
    $('prizeImage').value = prize ? prize.image || '' : '';
    $('prizeSort').value = prize ? prize.sort : state.prizes.length;
    $('prizeEnabled').checked = prize ? !!prize.enabled : true;
    $('prizeDialog').hidden = false;
  }

  async function savePrize() {
    const id = $('prizeId').value;
    const body = {
      name: $('prizeName').value,
      type: $('prizeType').value,
      weight: Number($('prizeWeight').value),
      stock: $('prizeStock').value === '' ? -1 : Number($('prizeStock').value),
      image: $('prizeImage').value,
      sort: Number($('prizeSort').value),
      enabled: $('prizeEnabled').checked,
    };
    try {
      if (id) await api('/api/admin/prizes/' + id, { method: 'PUT', body });
      else await api('/api/admin/prizes', { method: 'POST', body });
      $('prizeDialog').hidden = true;
      toast('奖品已保存');
      loadPrizes();
    } catch (e) {
      toast(e.message);
    }
  }

  // —— 参与者管理：查询/重置/分页/导出共用 readPlayerFilters ——
  function readPlayerFilters() {
    const f = {
      keyword: $('pKeyword').value.trim(),
      ip: $('pIp').value.trim(),
      blacklisted: $('pBlack').value,
      startDate: $('pStart').value,
      endDate: $('pEnd').value,
    };
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  }

  async function loadPlayers() {
    const qs = new URLSearchParams({ ...readPlayerFilters(), page: state.playersPage });
    try {
      const { total, page, pageSize, list } = await api('/api/admin/players?' + qs);
      $('playersPager').textContent = `第 ${page} 页 / 共 ${Math.max(1, Math.ceil(total / pageSize))} 页（${total} 人）`;
      $('pPrev').disabled = page <= 1;
      $('pNext').disabled = page * pageSize >= total;
      $('playerTbody').innerHTML =
        list
          .map(
            (p) => `
        <tr>
          <td>${esc(p.id)}</td>
          <td>${esc(p.email)}</td>
          <td>${esc(ipLabel(p.ip_first))}</td>
          <td>${esc(ipLabel(p.ip_last))}</td>
          <td>${esc(deviceLabel(p.device_type))}</td>
          <td>${esc(p.draw_total)} / ${esc(p.win_total)}</td>
          <td>${p.blacklisted ? '<span class="adm-tag adm-tag-danger">已拉黑</span>' : '—'}</td>
          <td>${esc(p.created_at || '')}</td>
          <td>
            <button class="adm-btn adm-btn-mini" data-player-detail="${p.id}">详情</button>
            <button class="adm-btn adm-btn-mini ${p.blacklisted ? '' : 'adm-btn-danger'}" data-player-black="${p.id}" data-cur="${p.blacklisted}">${p.blacklisted ? '解除' : '拉黑'}</button>
          </td>
        </tr>`
          )
          .join('') || '<tr><td colspan="9" class="adm-empty">无匹配记录</td></tr>';
    } catch (e) {
      toast(e.message);
    }
  }

  // 详情弹窗：展示完整邮箱与设备信息，支持备注保存与黑名单切换
  async function openPlayerDetail(id) {
    try {
      const { player, records } = await api('/api/admin/players/' + id);
      $('dEmail').textContent = player.email;
      $('dMeta').textContent = `首次IP：${ipLabel(player.ip_first)} ｜ 最近IP：${ipLabel(player.ip_last)} ｜ 设备：${deviceLabel(player.device_type)} ｜ UA：${(player.user_agent || '—').slice(0, 100)}`;
      $('dRemark').value = player.remark || '';
      $('dBlackBtn').dataset.id = player.id;
      $('dBlackBtn').dataset.cur = player.blacklisted;
      $('dBlackBtn').textContent = player.blacklisted ? '解除黑名单' : '加入黑名单';
      $('dRecords').innerHTML =
        records
          .map(
            (r) => `
        <tr>
          <td>${esc(r.drawn_at)}</td>
          <td>${esc(r.is_win ? r.prize_name : '谢谢参与')}</td>
          <td>${esc(r.prize_code || '—')}</td>
          <td>${esc(ipLabel(r.ip))}</td>
          <td>${esc(mailLabel(r.mail_status))}</td>
        </tr>`
          )
          .join('') || '<tr><td colspan="5" class="adm-empty">无抽奖记录</td></tr>';
      $('playerDialog').hidden = false;
    } catch (e) {
      toast(e.message);
    }
  }

  // —— 抽奖记录 ——
  function readRecordFilters() {
    const f = {
      email: $('rEmail').value.trim(),
      prizeId: $('rPrize').value,
      isWin: $('rWin').value,
      mailStatus: $('rMail').value,
      startDate: $('rStart').value,
      endDate: $('rEnd').value,
    };
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  }

  async function loadPrizeOptions() {
    try {
      const { list } = await api('/api/admin/prizes');
      state.prizes = list;
      $('rPrize').innerHTML =
        '<option value="">全部奖品</option>' +
        list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    } catch (e) {
      /* 奖品下拉失败不阻塞列表查询，仅选项缺失 */
    }
  }

  async function loadRecords() {
    const qs = new URLSearchParams({ ...readRecordFilters(), page: state.recordsPage });
    try {
      const { total, page, pageSize, list } = await api('/api/admin/records?' + qs);
      $('recordsPager').textContent = `第 ${page} 页 / 共 ${Math.max(1, Math.ceil(total / pageSize))} 页（${total} 条）`;
      $('rPrev').disabled = page <= 1;
      $('rNext').disabled = page * pageSize >= total;
      $('recordTbody').innerHTML =
        list
          .map(
            (r) => `
        <tr>
          <td>${esc(r.drawn_at)}</td>
          <td>${esc(r.email)}</td>
          <td>${esc(r.prize_name)}${r.blacklisted ? ' <span class="adm-tag adm-tag-danger">黑名单</span>' : ''}</td>
          <td>${r.is_win ? '中奖' : '未中奖'}</td>
          <td>${esc(r.prize_code || '—')}</td>
          <td>${esc(ipLabel(r.ip))}</td>
          <td>${esc(mailLabel(r.mail_status))}${r.mail_fail_reason ? '（' + esc(r.mail_fail_reason) + '）' : ''}</td>
          <td>${r.is_win && r.mail_status !== 'sent' ? `<button class="adm-btn adm-btn-mini" data-record-resend="${r.id}">重发</button>` : ''}</td>
        </tr>`
          )
          .join('') || '<tr><td colspan="8" class="adm-empty">无匹配记录</td></tr>';
    } catch (e) {
      toast(e.message);
    }
  }

  // 导出走 <a> 下载（Cookie 自动携带）；筛选参数与列表查询一致，保证所见即所得
  function downloadExport(path, filters) {
    const qs = new URLSearchParams(filters).toString();
    window.open(path + (qs ? '?' + qs : ''));
  }

  function bind() {
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('loginErr').hidden = true;
      try {
        const { username } = await api('/api/admin/login', {
          method: 'POST',
          body: { username: $('loginUser').value, password: $('loginPass').value },
        });
        showApp(username);
        switchTab('activity');
      } catch (err) {
        $('loginErr').textContent = err.message;
        $('loginErr').hidden = false;
      }
    });
    $('logoutBtn').addEventListener('click', async () => {
      try {
        await api('/api/admin/logout', { method: 'POST' });
      } catch (e) {
        /* 登出失败不阻塞本地退出 */
      }
      showLogin();
    });

    document.querySelectorAll('.adm-tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    $('activityForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveActivity();
    });
    $('actPublish').addEventListener('click', () => saveActivity('published'));
    $('actClose').addEventListener('click', () => saveActivity('closed'));

    $('prizeAddBtn').addEventListener('click', () => openPrizeDialog(null));
    $('prizeCancel').addEventListener('click', () => {
      $('prizeDialog').hidden = true;
    });
    $('prizeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      savePrize();
    });

    $('pSearch').addEventListener('click', () => {
      state.playersPage = 1;
      loadPlayers();
    });
    $('pReset').addEventListener('click', () => {
      ['pKeyword', 'pIp', 'pStart', 'pEnd'].forEach((id) => ($(id).value = ''));
      $('pBlack').value = '';
      state.playersPage = 1;
      loadPlayers();
    });
    $('pPrev').addEventListener('click', () => {
      state.playersPage -= 1;
      loadPlayers();
    });
    $('pNext').addEventListener('click', () => {
      state.playersPage += 1;
      loadPlayers();
    });
    $('pExport').addEventListener('click', () => downloadExport('/api/admin/players/export', readPlayerFilters()));

    $('rSearch').addEventListener('click', () => {
      state.recordsPage = 1;
      loadRecords();
    });
    $('rReset').addEventListener('click', () => {
      ['rEmail', 'rStart', 'rEnd'].forEach((id) => ($(id).value = ''));
      ['rPrize', 'rWin', 'rMail'].forEach((id) => ($(id).value = ''));
      state.recordsPage = 1;
      loadRecords();
    });
    $('rPrev').addEventListener('click', () => {
      state.recordsPage -= 1;
      loadRecords();
    });
    $('rNext').addEventListener('click', () => {
      state.recordsPage += 1;
      loadRecords();
    });
    $('rExport').addEventListener('click', () => downloadExport('/api/admin/records/export', readRecordFilters()));

    $('dSave').addEventListener('click', async () => {
      const id = $('dBlackBtn').dataset.id;
      try {
        await api(`/api/admin/players/${id}/blacklist`, { method: 'PUT', body: { remark: $('dRemark').value } });
        toast('备注已保存');
      } catch (e) {
        toast(e.message);
      }
    });
    $('dBlackBtn').addEventListener('click', async () => {
      const btn = $('dBlackBtn');
      const cur = btn.dataset.cur === '1';
      try {
        await api(`/api/admin/players/${btn.dataset.id}/blacklist`, {
          method: 'PUT',
          body: { blacklisted: !cur, remark: $('dRemark').value },
        });
        toast(cur ? '已解除黑名单' : '已加入黑名单');
        $('playerDialog').hidden = true;
        loadPlayers();
      } catch (e) {
        toast(e.message);
      }
    });
    $('dClose').addEventListener('click', () => {
      $('playerDialog').hidden = true;
    });
    document.querySelectorAll('[data-close-dialog]').forEach((m) =>
      m.addEventListener('click', (e) => {
        $(e.target.dataset.closeDialog).hidden = true;
      })
    );

    // 表格行内操作统一事件委托：编辑/启停/删除/详情/拉黑/重发
    document.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-prize-edit]');
      if (edit) {
        const p = state.prizes.find((x) => x.id === Number(edit.dataset.prizeEdit));
        if (p) openPrizeDialog(p);
        return;
      }
      const toggle = e.target.closest('[data-prize-toggle]');
      if (toggle) {
        const p = state.prizes.find((x) => x.id === Number(toggle.dataset.prizeToggle));
        if (p) {
          try {
            await api('/api/admin/prizes/' + p.id, { method: 'PUT', body: { ...p, enabled: p.enabled ? 0 : 1 } });
            loadPrizes();
          } catch (err) {
            toast(err.message);
          }
        }
        return;
      }
      const del = e.target.closest('[data-prize-del]');
      if (del) {
        if (!window.confirm('确认删除该奖品？已有抽奖记录的奖品将改为停用。')) return;
        try {
          const r = await api('/api/admin/prizes/' + del.dataset.prizeDel, { method: 'DELETE' });
          if (r.message) toast(r.message);
          loadPrizes();
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      const detail = e.target.closest('[data-player-detail]');
      if (detail) {
        openPlayerDetail(Number(detail.dataset.playerDetail));
        return;
      }
      const black = e.target.closest('[data-player-black]');
      if (black) {
        const cur = black.dataset.cur === '1';
        try {
          await api(`/api/admin/players/${black.dataset.playerBlack}/blacklist`, {
            method: 'PUT',
            body: { blacklisted: !cur },
          });
          toast(cur ? '已解除黑名单' : '已加入黑名单');
          loadPlayers();
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      const resend = e.target.closest('[data-record-resend]');
      if (resend) {
        resend.disabled = true;
        try {
          await api(`/api/admin/records/${resend.dataset.recordResend}/resend`, { method: 'POST' });
          toast('重发完成');
          loadRecords();
        } catch (err) {
          toast(err.message);
          resend.disabled = false;
        }
      }
    });
  }

  async function init() {
    bind();
    try {
      const { username } = await api('/api/admin/me');
      showApp(username);
      switchTab('activity');
    } catch (e) {
      /* 未登录：api() 已统一切到登录页 */
    }
  }

  init();
})();
