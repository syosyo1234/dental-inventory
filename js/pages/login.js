// =====================================================================
// login.js  登录页
// =====================================================================
import { supabase, isConfigured } from '../supabaseClient.js';
import { DEMO_ACCOUNT } from '../config.js';
import { safeNext } from '../auth.js';
import { escapeHtml, setBusy, isNetworkError } from '../ui.js';

const form = document.getElementById('login-form');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const button = document.getElementById('login-btn');
const messageEl = document.getElementById('message');
const params = new URLSearchParams(location.search);

function showMessage(text, type = 'error') {
  messageEl.className = `alert alert-${type}`;
  messageEl.textContent = text;
  messageEl.hidden = false;
}

// Supabase Auth 的英文错误 → 日语
function authErrorMessage(error) {
  const msg = error?.message ?? '';
  if (isNetworkError(error)) {
    return 'サーバーに接続できません。通信状況を確認してください。（デモ環境が休止中の可能性があります）';
  }
  if (/Invalid login credentials/i.test(msg)) return 'メールアドレスまたはパスワードが正しくありません。';
  if (/Email not confirmed/i.test(msg)) return 'メールアドレスの確認が完了していません。';
  if (/rate limit|too many/i.test(msg)) return 'ログイン試行回数が多すぎます。しばらく待ってから再度お試しください。';
  return 'ログインに失敗しました。時間をおいて再度お試しください。';
}

async function init() {
  if (!isConfigured) {
    showMessage('接続設定が完了していません。js/config.js に Supabase の Project URL と Publishable key を設定してください。', 'warning');
    form.querySelectorAll('input, button').forEach((el) => (el.disabled = true));
    return;
  }

  // 已登录则直接进入
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    location.replace(safeNext(params.get('next')));
    return;
  }

  const reasons = {
    inactive: ['このアカウントは利用できません。管理者にお問い合わせください。', 'error'],
    expired: ['ログインの有効期限が切れました。再度ログインしてください。', 'warning'],
    signed_out: ['ログアウトしました。', 'info'],
  };
  const reason = reasons[params.get('reason')];
  if (reason) showMessage(...reason);

  // 演示账号（config.js 中设置时才显示）
  if (DEMO_ACCOUNT?.email) {
    const box = document.getElementById('demo-box');
    box.innerHTML = `
      <strong>デモ用アカウント</strong><br>
      メール：${escapeHtml(DEMO_ACCOUNT.email)}<br>
      パスワード：${escapeHtml(DEMO_ACCOUNT.password)}<br>
      <button type="button" class="btn btn-sm" style="margin-top:8px" id="fill-demo">入力する</button>`;
    box.hidden = false;
    document.getElementById('fill-demo').addEventListener('click', () => {
      emailEl.value = DEMO_ACCOUNT.email;
      passwordEl.value = DEMO_ACCOUNT.password;
    });
  }

  emailEl.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailEl.value.trim();
  const password = passwordEl.value;

  emailEl.classList.toggle('is-invalid', !email);
  passwordEl.classList.toggle('is-invalid', !password);
  if (!email || !password) {
    showMessage('メールアドレスとパスワードを入力してください。');
    return;
  }

  const done = setBusy(button, 'ログイン中…');
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      showMessage(authErrorMessage(error));
      return;
    }
    location.replace(safeNext(params.get('next')));
  } catch (err) {
    showMessage(authErrorMessage(err));
  } finally {
    done();
  }
});

init();
