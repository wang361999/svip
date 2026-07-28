<?php
/**
 * 模拟盘引擎触发器 & 状态面板 v2
 * 
 * 功能：
 * - 浏览器打开：显示面板，手动触发，看日志
 * - Cron / ?mode=cron：自动循环触发
 * - 同时支持 curl 和 file_get_contents 两种 HTTP 方式
 */

// ==================== 配置 ====================
$API_URL    = 'https://ethhy.cn';
$ENGINE_KEY = 'eth-engine-secret-2024';
$INTERVAL   = 2;
$MAX_RUNTIME = 25;
$ENDPOINT   = '/api/paper/engine';
$LOG_FILE   = __DIR__ . '/trigger_log.txt';

// ==================== 工具函数 ====================

/** 发请求（优先 curl，不支持则用 file_get_contents） */
function fireEngine() {
    global $API_URL, $ENGINE_KEY, $ENDPOINT;
    $url = $API_URL . $ENDPOINT;
    $headers = [
        "Content-Type: application/json",
        "X-Engine-Key: {$ENGINE_KEY}",
    ];

    // 方式 1：curl
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => '{}',
            CURLOPT_HTTPHEADER => $headers,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        curl_close($ch);
        if ($body !== false) {
            return ['code' => $code, 'body' => $body, 'error' => $err];
        }
    }

    // 方式 2：file_get_contents
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => '{}',
            'timeout' => 10,
            'follow_location' => 1,
            'max_redirects' => 3,
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false,
        ],
    ]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
        return ['code' => 0, 'body' => '', 'error' => '请求失败'];
    }
    // 从 $http_response_header 提取状态码
    $code = 200;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $line) {
            if (preg_match('/HTTP\/\S+\s+(\d+)/', $line, $m)) {
                $code = intval($m[1]);
                break;
            }
        }
    }
    return ['code' => $code, 'body' => $body, 'error' => ''];
}

/** 写日志 */
function writeLog($text) {
    global $LOG_FILE;
    $line = date('Y-m-d H:i:s') . ' ' . $text . "\n";
    @file_put_contents($LOG_FILE, $line, FILE_APPEND);
}

/** 读最近 N 条日志 */
function readLogs($n = 20) {
    global $LOG_FILE;
    if (!file_exists($LOG_FILE)) return [];
    $lines = file($LOG_FILE, FILE_IGNORE_NEW_LINES);
    if (!$lines) return [];
    return array_slice(array_reverse($lines), 0, $n);
}

/** 读取今日统计 */
function todayStats() {
    global $LOG_FILE;
    if (!file_exists($LOG_FILE)) return ['count' => 0, 'success' => 0, 'fail' => 0];
    $today = date('Y-m-d');
    $count = $success = $fail = 0;
    foreach (file($LOG_FILE, FILE_IGNORE_NEW_LINES) as $line) {
        if (strpos($line, $today) === false) continue;
        if (preg_match('/(\d+)次.*成功(\d+).*失败(\d+)/', $line, $m)) {
            $count += intval($m[1]);
            $success += intval($m[2]);
            $fail += intval($m[3]);
        }
    }
    return ['count' => $count, 'success' => $success, 'fail' => $fail];
}

// ==================== 路由 ====================
$action = $_GET['action'] ?? '';

// 手动触发
if ($action === 'fire') {
    header('Content-Type: application/json; charset=utf-8');
    $r = fireEngine();
    $ok = $r['code'] >= 200 && $r['code'] < 300;
    writeLog($ok ? "手动触发成功" : "手动触发失败 HTTP {$r['code']} {$r['error']}");
    echo json_encode(['ok' => $ok, 'code' => $r['code'], 'body' => $r['body']], JSON_UNESCAPED_UNICODE);
    exit;
}

// 清除日志
if ($action === 'clear_log') {
    header('Content-Type: application/json; charset=utf-8');
    @file_put_contents($LOG_FILE, '');
    echo json_encode(['ok' => true]);
    exit;
}

// Cron 模式
if (php_sapi_name() === 'cli' || (isset($_GET['mode']) && $_GET['mode'] === 'cron')) {
    $start = time();
    $count = $success = $fail = 0;
    while (true) {
        if (time() - $start >= $MAX_RUNTIME) break;
        $r = fireEngine();
        $count++;
        if ($r['code'] >= 200 && $r['code'] < 300) { $success++; } else { $fail++; }
        if (time() - $start + $INTERVAL >= $MAX_RUNTIME) break;
        sleep($INTERVAL);
    }
    $elapsed = time() - $start;
    writeLog("Cron: {$count}次 成功{$success} 失败{$fail} 耗时{$elapsed}s");
    echo "触发 {$count} 次 | 成功 {$success} | 失败 {$fail} | 耗时 {$elapsed}s\n";
    exit;
}

// ==================== 面板 ====================
$logs = readLogs(20);
$today = todayStats();
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>引擎触发器</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0e1a;color:#e2e8f0;min-height:100vh;padding:16px}
.wrap{max-width:480px;margin:0 auto}
.card{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:16px;margin-bottom:12px}
.header{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.header .icon{width:28px;height:28px;border-radius:8px;background:rgba(59,130,246,.15);display:flex;align-items:center;justify-content:center;font-size:14px}
.header h1{font-size:16px;font-weight:600}
.header .sub{font-size:11px;color:#64748b;margin-left:auto}
.status-row{display:flex;gap:8px;margin-bottom:12px}
.status-box{flex:1;background:#0f172a;border-radius:8px;padding:10px;text-align:center}
.status-box .num{font-size:18px;font-weight:700;font-family:monospace}
.status-box .lbl{font-size:10px;color:#64748b;margin-top:2px}
.status-box.ok .num{color:#22c55e}
.status-box.err .num{color:#ef4444}
.status-box.total .num{color:#3b82f6}
.auto-status{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px;margin-bottom:12px}
.auto-status .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
.auto-status .text{font-size:12px;color:#22c55e;font-weight:500}
.auto-status .hint{font-size:10px;color:#475569;margin-left:auto}
.info-row{display:flex;justify-content:space-between;padding:6px 0;font-size:12px}
.info-row .lbl{color:#64748b}
.info-row .val{font-family:monospace;color:#cbd5e1}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
.btn:active{transform:scale(.98)}
.btn-fire{background:#3b82f6;color:#fff;margin-bottom:8px}
.btn-fire:hover{background:#2563eb}
.btn-fire:disabled{background:#334155;color:#64748b;cursor:not-allowed}
.btn-clear{background:transparent;border:1px solid #1e293b;color:#64748b;font-size:11px;padding:8px}
.btn-clear:hover{border-color:#475569;color:#94a3b8}
.result{padding:10px;border-radius:8px;font-size:11px;font-family:monospace;word-break:break-all;display:none;margin-bottom:8px}
.result.show{display:block}
.result.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);color:#22c55e}
.result.err{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#ef4444}
.logs-title{font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.logs{max-height:260px;overflow-y:auto;font-family:monospace;font-size:10px}
.logs div{padding:3px 0;border-bottom:1px solid #0f172a;color:#94a3b8}
.logs div:last-child{border-bottom:none}
.empty{text-align:center;color:#334155;padding:24px 0;font-size:12px}
.cron-cmd{background:#0f172a;border-radius:6px;padding:8px;font-size:10px;font-family:monospace;color:#64748b;word-break:break-all;margin-top:4px}
.cron-cmd code{color:#3b82f6}
</style>
</head>
<body>
<div class="wrap">

<div class="card">
  <div class="header">
    <div class="icon">⚡</div>
    <h1>引擎触发器</h1>
    <span class="sub"><?= $today['count'] ?> 次/今日</span>
  </div>

  <!-- 自动状态 -->
  <div class="auto-status" id="autoBar">
    <span class="dot"></span>
    <span class="text" id="autoText">点击下方按钮开启自动触发</span>
    <span class="hint" id="autoHint"></span>
  </div>
  <button class="btn btn-fire" onclick="toggleAuto()" id="autoBtn" style="margin-bottom:8px;background:#334155;color:#94a3b8">开启自动触发</button>

  <!-- 今日统计 -->
  <div class="status-row">
    <div class="status-box total">
      <div class="num"><?= $today['count'] ?></div>
      <div class="lbl">今日总触发</div>
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

  <!-- 配置信息 -->
  <div class="info-row">
    <span class="lbl">目标地址</span>
    <span class="val"><?= htmlspecialchars($API_URL) ?></span>
  </div>
  <div class="info-row">
    <span class="lbl">触发间隔</span>
    <span class="val"><?= $INTERVAL ?> 秒</span>
  </div>
  <div class="info-row">
    <span class="lbl">单次执行</span>
    <span class="val"><?= $MAX_RUNTIME ?> 秒</span>
  </div>

  <!-- 手动触发 -->
  <button class="btn btn-fire" onclick="fire()" id="fireBtn">手动触发一次</button>
  <div class="result" id="result"></div>
  <button class="btn btn-clear" onclick="clearLog()">清除日志</button>
</div>

<div class="card">
  <div class="logs-title">运行日志</div>
  <?php if (empty($logs)): ?>
    <div class="empty">暂无日志</div>
  <?php else: ?>
    <div class="logs">
      <?php foreach ($logs as $line): ?>
        <div><?= htmlspecialchars($line) ?></div>
      <?php endforeach; ?>
    </div>
  <?php endif; ?>
</div>

<div class="card">
  <div class="logs-title">Cron 配置</div>
  <div class="cron-cmd">
    <code>/usr/local/bin/php /home/vol6_2/mp_42491248/htdocs/trigger.php</code>
  </div>
  <div style="font-size:10px;color:#475569;margin-top:6px">VistaPanel → Cron Jobs → 选 Every Minute → 粘贴上方命令</div>
</div>

</div>
<script>
function fire(){
  var btn=document.getElementById('fireBtn');
  var box=document.getElementById('result');
  btn.disabled=true;btn.textContent='触发中...';
  fetch('?action=fire').then(function(r){return r.json()}).then(function(d){
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
  fetch('?action=clear_log').then(function(){location.reload()});
}
</script>
</body>
</html>
