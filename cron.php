<?php
/**
 * 外部 Cron 触发器 v3（简洁稳定版）
 * 
 * 设计理念：不搞后台循环，每次 Cron 触发执行 1 次立即返回
 * cron-job.org 每分钟触发一次 = 引擎每分钟检查一次，完全够用
 * 
 * 如果觉得 1 分钟间隔太长，可以注册 2 个 cron-job.org 账号
 * 两个账号同时每分钟触发 = 每 30 秒一次
 */

// ==================== 配置 ====================
$API_URL    = 'https://ethhy.cn';
$ENGINE_KEY = 'eth-engine-secret-2024';
$CRON_KEY   = 'my-cron-secret-key-2024';
$ENDPOINT   = '/api/paper/engine';
$LOG_FILE   = __DIR__ . '/cron_log.txt';

// ==================== 验证 ====================
$getKey = $_GET['key'] ?? '';
if ($getKey !== $CRON_KEY) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => '密钥错误'], JSON_UNESCAPED_UNICODE);
    exit;
}

// ==================== 工具函数 ====================

function fireEngine() {
    global $API_URL, $ENGINE_KEY, $ENDPOINT;
    $url = $API_URL . $ENDPOINT;
    $headers = [
        "Content-Type: application/json",
        "X-Engine-Key: {$ENGINE_KEY}",
    ];

    // 方式 1：curl（优先使用）
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => '{}',
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => false,
            CURLOPT_USERAGENT => 'ETH-Cron-Trigger/1.0',
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        $finalUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);
        if ($body !== false && $code > 0) {
            return ['code' => $code, 'body' => $body, 'error' => $err];
        }
        // curl 失败，降级到 file_get_contents
    }

    // 方式 2：file_get_contents（带重定向支持）
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => '{}',
            'timeout' => 15,
            'follow_location' => 1,
            'max_redirects' => 5,
            'user_agent' => 'ETH-Cron-Trigger/1.0',
            'ignore_errors' => true,  // 即使 4xx/5xx 也返回内容
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false,
        ],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
        return ['code' => 0, 'body' => '', 'error' => 'curl和file_get_contents均失败'];
    }
    // 从 $http_response_header 提取最终状态码（取最后一个，跳过重定向）
    $code = 200;
    if (isset($http_response_header) && is_array($http_response_header)) {
        $lastCode = 0;
        foreach ($http_response_header as $line) {
            if (preg_match('/HTTP\/\S+\s+(\d+)/', $line, $m)) {
                $lastCode = intval($m[1]);  // 保留最后一个状态码
            }
        }
        if ($lastCode > 0) $code = $lastCode;
    }
    return ['code' => $code, 'body' => $body, 'error' => ''];
}

function writeLog($text) {
    global $LOG_FILE;
    $line = date('Y-m-d H:i:s') . ' ' . $text . "\n";
    $f = fopen($LOG_FILE, 'a');
    if (flock($f, LOCK_EX)) {
        fwrite($f, $line);
        flock($f, LOCK_UN);
    }
    fclose($f);
    $lines = file($LOG_FILE, FILE_IGNORE_NEW_LINES);
    if ($lines && count($lines) > 500) {
        $lines = array_slice($lines, -500);
        file_put_contents($LOG_FILE, implode("\n", $lines) . "\n");
    }
}

function readLogs($n = 30) {
    global $LOG_FILE;
    if (!file_exists($LOG_FILE)) return [];
    $lines = file($LOG_FILE, FILE_IGNORE_NEW_LINES);
    if (!$lines) return [];
    return array_slice(array_reverse($lines), 0, $n);
}

function todayStats() {
    global $LOG_FILE;
    if (!file_exists($LOG_FILE)) return ['count' => 0, 'success' => 0, 'fail' => 0, 'lastTime' => '--'];
    $today = date('Y-m-d');
    $count = $success = $fail = 0;
    $lastTime = '';
    foreach (file($LOG_FILE, FILE_IGNORE_NEW_LINES) as $line) {
        if (strpos($line, $today) === false) continue;
        if (preg_match('/成功/', $line)) $success++;
        if (preg_match('/失败/', $line)) $fail++;
        $count++;
        if (!$lastTime) {
            preg_match('/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/', $line, $m);
            $lastTime = $m[1] ?? '';
        }
    }
    return ['count' => $count, 'success' => $success, 'fail' => $fail, 'lastTime' => $lastTime ?: '--'];
}

// ==================== 路由 ====================
$action = $_GET['action'] ?? '';

// 面板
if ($action === 'panel') {
    $logs = readLogs(30);
    $today = todayStats();
    $isJson = isset($_GET['json']);
    if ($isJson) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => true, 'today' => $today, 'recentLogs' => array_slice($logs, 0, 5)], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $selfUrl = (isset($_SERVER['HTTPS']) ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['SCRIPT_NAME'];
    $cronUrl = $selfUrl . '?key=' . urlencode($CRON_KEY);
    ?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Cron 触发器</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0e1a;color:#e2e8f0;min-height:100vh;padding:12px}
.wrap{max-width:480px;margin:0 auto}
.card{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:14px;margin-bottom:10px}
.header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.header .icon{width:28px;height:28px;border-radius:8px;background:rgba(59,130,246,.15);display:flex;align-items:center;justify-content:center;font-size:14px}
.header h1{font-size:15px;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:9px;font-weight:600}
.badge-on{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3)}
.badge-off{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.status-row{display:flex;gap:8px;margin-bottom:10px}
.status-box{flex:1;background:#0f172a;border-radius:8px;padding:8px;text-align:center}
.status-box .num{font-size:20px;font-weight:700;font-family:monospace}
.status-box .lbl{font-size:9px;color:#64748b;margin-top:2px}
.status-box.ok .num{color:#22c55e}
.status-box.err .num{color:#ef4444}
.status-box.total .num{color:#3b82f6}
.section-title{font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.logs{max-height:200px;overflow-y:auto;font-family:monospace;font-size:9px}
.logs div{padding:2px 0;border-bottom:1px solid #0f172a;color:#94a3b8}
.logs div:last-child{border-bottom:none}
.logs div.ok{color:#22c55e}
.logs div.err{color:#ef4444}
.empty{text-align:center;color:#334155;padding:20px 0;font-size:11px}
.url-box{background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px;font-size:10px;font-family:monospace;color:#64748b;word-break:break-all;margin-top:6px;position:relative}
.url-box code{color:#3b82f6}
.url-box .copy-btn{position:absolute;top:6px;right:6px;background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer}
.url-box .copy-btn:hover{background:#334155;color:#e2e8f0}
.steps{font-size:10px;color:#94a3b8;line-height:1.8}
.steps b{color:#e2e8f0}
.btn{display:block;width:100%;padding:10px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.btn:active{transform:scale(.98)}
.btn-fire{background:#3b82f6;color:#fff;margin-bottom:6px}
.btn-fire:hover{background:#2563eb}
.btn-fire:disabled{background:#334155;color:#64748b;cursor:not-allowed}
.btn-clear{background:transparent;border:1px solid #1e293b;color:#64748b;font-size:10px;padding:7px}
.btn-clear:hover{border-color:#475569;color:#94a3b8}
.result{padding:8px;border-radius:8px;font-size:10px;font-family:monospace;word-break:break-all;display:none;margin-bottom:6px}
.result.show{display:block}
.result.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);color:#22c55e}
.result.err{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#ef4444}
.auto-bar{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px;margin-bottom:10px}
.auto-bar .dot{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
.auto-bar .text{font-size:11px;color:#22c55e}
.auto-bar .time{font-size:9px;color:#64748b;margin-left:auto}
.tip{background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.15);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:10px;color:#64748b;line-height:1.6}
.tip b{color:#3b82f6}
</style>
</head>
<body>
<div class="wrap">

<div class="card">
  <div class="header">
    <div class="icon">⚡</div>
    <h1>Cron 触发器 v3</h1>
    <span class="badge <?= $today['count'] > 0 ? 'badge-on' : 'badge-off' ?>"><?= $today['count'] > 0 ? '运行中' : '未触发' ?></span>
  </div>

  <?php if ($today['lastTime'] !== '--'): ?>
  <div class="auto-bar">
    <span class="dot"></span>
    <span class="text">Cron 正常触发中</span>
    <span class="time">最近: <?= $today['lastTime'] ?></span>
  </div>
  <?php else: ?>
  <div class="auto-bar" style="background:rgba(239,68,68,.06);border-color:rgba(239,68,68,.15)">
    <span class="dot" style="background:#ef4444"></span>
    <span class="text" style="color:#ef4444">尚未收到 Cron 触发</span>
    <span class="time">请按下方步骤配置</span>
  </div>
  <?php endif; ?>

  <div class="status-row">
    <div class="status-box total">
      <div class="num"><?= $today['count'] ?></div>
      <div class="lbl">今日触发</div>
    </div>
    <div class="status-box ok">
      <div class="num"><?= $today['success'] ?></div>
      <div class="lbl">成功</div>
    </div>
    <div class="status-box err">
      <div class="num"><?= $today['fail'] ?></div>
      <div class="lbl">失败</div>
    </div>
  </div>

  <button class="btn btn-fire" onclick="fire()" id="fireBtn">手动触发一次</button>
  <div class="result" id="result"></div>
  <button class="btn btn-clear" onclick="clearLog()">清除日志</button>
</div>

<div class="card">
  <div class="section-title">运行日志</div>
  <?php if (empty($logs)): ?>
    <div class="empty">暂无日志</div>
  <?php else: ?>
    <div class="logs">
      <?php foreach ($logs as $line): ?>
        <div class="<?= strpos($line, '成功') !== false ? 'ok' : (strpos($line, '失败') !== false ? 'err' : '') ?>"><?= htmlspecialchars($line) ?></div>
      <?php endforeach; ?>
    </div>
  <?php endif; ?>
</div>

<div class="card">
  <div class="section-title">Cron 配置（cron-job.org）</div>
  <div class="tip">
    <b>方案：</b>Cron 每分钟触发 1 次 = 引擎每分钟检查 1 次。<br>
    觉得间隔长？注册 2 个 cron-job.org 账号同时跑 = 每 30 秒一次。
  </div>
  <div class="steps">
    <b>1.</b> 注册 <a href="https://cron-job.org" target="_blank" style="color:#3b82f6">cron-job.org</a>（免费）<br>
    <b>2.</b> 创建 Cron Job，Title 填 <b>ETH引擎</b><br>
    <b>3.</b> URL 粘贴下方地址（不要多加任何字符）：<br>
  </div>
  <div class="url-box">
    <code id="cronUrl"><?= htmlspecialchars($cronUrl) ?></code>
    <button class="copy-btn" onclick="copyUrl()">复制</button>
  </div>
  <div class="steps" style="margin-top:8px">
    <b>4.</b> Schedule 选 <b>Every 1 minute</b><br>
    <b>5.</b> Save 保存
  </div>
</div>

</div>
<script>
function fire(){
  var btn=document.getElementById('fireBtn');
  var box=document.getElementById('result');
  btn.disabled=true;btn.textContent='触发中...';
  var url='?key=<?= urlencode($CRON_KEY) ?>&action=manual';
  fetch(url).then(function(r){return r.json()}).then(function(d){
    box.className='result show '+(d.ok?'ok':'err');
    box.textContent=d.ok?'✓ 成功 '+d.body:'✗ 失败 HTTP '+d.code+(d.body?' '+d.body:'');
  }).catch(function(e){
    box.className='result show err';
    box.textContent='✗ 异常: '+e.message;
  }).finally(function(){
    btn.disabled=false;btn.textContent='手动触发一次';
  });
}
function clearLog(){
  fetch('?key=<?= urlencode($CRON_KEY) ?>&action=clear_log').then(function(){location.reload()});
}
function copyUrl(){
  var url=document.getElementById('cronUrl').textContent;
  navigator.clipboard.writeText(url).then(function(){
    var btn=document.querySelector('.copy-btn');btn.textContent='已复制';setTimeout(function(){btn.textContent='复制'},1500);
  });
}
</script>
</body>
</html>
<?php
    exit;
}

// 清除日志
if ($action === 'clear_log') {
    header('Content-Type: application/json; charset=utf-8');
    @file_put_contents($LOG_FILE, '');
    echo json_encode(['ok' => true]);
    exit;
}

// 手动触发
if ($action === 'manual') {
    header('Content-Type: application/json; charset=utf-8');
    $r = fireEngine();
    $ok = $r['code'] >= 200 && $r['code'] < 300;
    writeLog($ok ? "手动触发成功 HTTP {$r['code']}" : "手动触发失败 HTTP {$r['code']} {$r['error']}");
    echo json_encode(['ok' => $ok, 'code' => $r['code'], 'body' => mb_substr($r['body'], 0, 200)], JSON_UNESCAPED_UNICODE);
    exit;
}

// ==================== 核心：Cron 触发（单次，立即返回） ====================

$r = fireEngine();
$ok = $r['code'] >= 200 && $r['code'] < 300;
$bodyShort = mb_substr($r['body'], 0, 100);
writeLog($ok ? "触发成功 HTTP {$r['code']} {$bodyShort}" : "触发失败 HTTP {$r['code']} err={$r['error']} body={$bodyShort}");

header('Content-Type: application/json; charset=utf-8');
// 失败时也返回 200，防止 cron-job.org 标记为失败
http_response_code(200);
echo json_encode([
    'ok' => $ok,
    'code' => $r['code'],
    'body' => mb_substr($r['body'], 0, 200),
    'error' => $r['error'],
], JSON_UNESCAPED_UNICODE);
