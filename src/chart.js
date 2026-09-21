import { METRICS, formatBytes, formatMetric, formatMs } from './format.js';

const STAGE_COLORS = {
  idle: '#e2e8f0',
  dns: '#f59e0b',
  connect: '#8b5cf6',
  request: '#f97316',
  download: '#2563eb',
  business: '#10b981',
  wait: '#cbd5e1'
};

export class StrategyChart {
  constructor(canvas, emptyElement) {
    this.canvas = canvas;
    this.emptyElement = emptyElement;
    this.ctx = canvas.getContext('2d');
    this.report = null;
    this.metricId = 'elapsedMs';
    this.mode = 'comparison';
    this.width = 0;
    this.height = 0;
    this.hitAreas = [];
    this.hover = null;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener('mousemove', event => this.handlePointer(event));
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.render();
    });
    this.resize();
  }

  setReport(report) {
    this.report = report;
    this.emptyElement.hidden = Boolean(report);
    this.render();
  }

  setMetric(metricId) {
    this.metricId = metricId;
    this.render();
  }

  setMode(mode) {
    this.mode = mode;
    this.render();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  handlePointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = this.hitAreas.find(area =>
      x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h
    );
    const nextHover = hit ? hit.key : null;
    if (nextHover !== this.hover) {
      this.hover = nextHover;
      this.render();
    }
  }

  render() {
    if (!this.width || !this.height) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.hitAreas = [];

    if (!this.report) {
      this.drawEmpty();
      return;
    }

    if (this.mode === 'waterfall') this.drawWaterfall();
    else if (this.mode === 'stability') this.drawStability();
    else this.drawComparison();
  }

  drawEmpty() {
    const { ctx, width, height } = this;
    ctx.fillStyle = '#64748b';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('运行实验后显示 Canvas 图表', width / 2, height / 2);
  }

  getMetric() {
    return METRICS.find(metric => metric.id === this.metricId) || METRICS[0];
  }

  getRows() {
    return this.report.strategies.map(strategy => ({
      key: strategy.strategyId,
      label: strategy.label,
      color: strategy.color,
      stats: strategy.metricStats[this.metricId] || emptyStats(),
      strategy
    }));
  }

  getPlotLayout() {
    const compact = this.width < 720;
    return {
      left: compact ? 92 : 136,
      right: compact ? 18 : 42,
      top: compact ? 92 : 72,
      bottom: 48,
      barHeight: compact ? 20 : 26,
      gap: compact ? 16 : 20
    };
  }

  drawTitle(subtitle) {
    const metric = this.getMetric();
    this.ctx.fillStyle = '#0f172a';
    this.ctx.font = '800 17px system-ui, sans-serif';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    this.ctx.fillText(subtitle || metric.description, 22, 18);
    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '600 12px system-ui, sans-serif';
    this.ctx.fillText(`指标：${metric.label}（${metric.unit === 'B' ? '字节' : '毫秒'}） · 阴影/线段表示最小到 P95`, 22, 43);
  }

  drawGrid(maxValue, layout, formatter) {
    const plotWidth = this.width - layout.left - layout.right;
    this.ctx.strokeStyle = '#e2e8f0';
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '600 11px system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';

    for (let step = 0; step <= 4; step += 1) {
      const value = maxValue * step / 4;
      const x = layout.left + plotWidth * step / 4;
      this.ctx.beginPath();
      this.ctx.moveTo(x, layout.top - 10);
      this.ctx.lineTo(x, this.height - layout.bottom + 10);
      this.ctx.stroke();
      this.ctx.fillText(formatter(value), x, this.height - layout.bottom + 18);
    }
  }

  valueX(value, maxValue, layout) {
    const plotWidth = this.width - layout.left - layout.right;
    return layout.left + (maxValue ? value / maxValue * plotWidth : 0);
  }

  drawLabels(rows, layout) {
    this.ctx.font = '750 13px system-ui, sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';
    rows.forEach((row, index) => {
      const y = layout.top + index * (layout.barHeight + layout.gap) + layout.barHeight / 2;
      this.ctx.fillStyle = '#334155';
      this.ctx.fillText(row.label, layout.left - 14, y);
    });
  }

  drawComparison() {
    const layout = this.getPlotLayout();
    const rows = this.getRows();
    const maxValue = Math.max(1, ...rows.map(row => row.stats.p95 || row.stats.median || 0));
    this.drawTitle();
    this.drawGrid(maxValue, layout, value => this.getMetric().unit === 'B' ? formatBytes(value) : formatMs(value));

    rows.forEach((row, index) => {
      const y = layout.top + index * (layout.barHeight + layout.gap);
      const medianWidth = this.valueX(row.stats.median || 0, maxValue, layout) - layout.left;
      const minX = this.valueX(row.stats.min || 0, maxValue, layout);
      const maxX = this.valueX(row.stats.max || 0, maxValue, layout);
      const p95X = this.valueX(row.stats.p95 || 0, maxValue, layout);

      this.ctx.fillStyle = this.hover === row.key ? row.color : `${row.color}33`;
      this.ctx.fillRect(minX, y + 7, Math.max(1, maxX - minX), layout.barHeight - 14);

      this.ctx.fillStyle = row.color;
      this.ctx.fillRect(minX, y + 7, Math.max(1, maxX - minX), 3);

      this.ctx.fillStyle = row.color;
      roundedRect(this.ctx, layout.left, y, Math.max(2, medianWidth), layout.barHeight, 7);
      this.ctx.fill();

      this.ctx.strokeStyle = '#0f172a';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(p95X, y + 4);
      this.ctx.lineTo(p95X, y + layout.barHeight - 4);
      this.ctx.stroke();

      this.ctx.fillStyle = '#0f172a';
      this.ctx.font = '800 12px system-ui, sans-serif';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(formatMetric(this.metricId, row.stats.median), p95X + 7, y + layout.barHeight / 2);

      this.hitAreas.push({
        key: row.key,
        x: layout.left,
        y,
        w: this.width - layout.left - layout.right,
        h: layout.barHeight,
        row
      });
    });

    this.drawLabels(rows, layout);
    this.drawTooltip(rows, layout);
  }

  drawStability() {
    const layout = this.getPlotLayout();
    const rows = this.getRows();
    const maxValue = Math.max(1, ...rows.map(row => row.stats.max || 0));
    this.drawTitle('稳定性视图：短线为最小/最大范围，深色刻度为 P95，圆点为中位数');
    this.drawGrid(maxValue, layout, value => this.getMetric().unit === 'B' ? formatBytes(value) : formatMs(value));

    rows.forEach((row, index) => {
      const y = layout.top + index * (layout.barHeight + layout.gap);
      const centerY = y + layout.barHeight / 2;
      const minX = this.valueX(row.stats.min || 0, maxValue, layout);
      const maxX = this.valueX(row.stats.max || 0, maxValue, layout);
      const medianX = this.valueX(row.stats.median || 0, maxValue, layout);
      const p95X = this.valueX(row.stats.p95 || 0, maxValue, layout);

      this.ctx.strokeStyle = `${row.color}88`;
      this.ctx.lineWidth = 4;
      this.ctx.beginPath();
      this.ctx.moveTo(minX, centerY);
      this.ctx.lineTo(maxX, centerY);
      this.ctx.stroke();

      this.ctx.strokeStyle = '#0f172a';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(p95X, y + 4);
      this.ctx.lineTo(p95X, y + layout.barHeight - 4);
      this.ctx.stroke();

      this.ctx.fillStyle = '#fff';
      this.ctx.strokeStyle = row.color;
      this.ctx.lineWidth = 4;
      this.ctx.beginPath();
      this.ctx.arc(medianX, centerY, 8, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();

      this.hitAreas.push({ key: row.key, x: layout.left, y, w: this.width - layout.left - layout.right, h: layout.barHeight, row });
    });

    this.drawLabels(rows, layout);
    this.drawTooltip(rows, layout);
  }

  drawWaterfall() {
    const layout = this.getPlotLayout();
    const rows = this.report.strategies
      .filter(strategy => strategy.timeline)
      .map(strategy => ({
        key: strategy.strategyId,
        label: strategy.label,
        color: strategy.color,
        timeline: strategy.timeline,
        strategy
      }));
    const maxValue = Math.max(
      1,
      ...rows.map(row => Math.max(row.timeline.end, row.timeline.responseEnd || 0))
    );

    this.drawTitle('中位数资源时间线：灰色为提示提前量，绿色刻度为业务代码开始取用资源');
    this.drawGrid(maxValue, layout, value => formatMs(value));

    rows.forEach((row, index) => {
      const y = layout.top + index * (layout.barHeight + layout.gap);
      const centerY = y + layout.barHeight / 2;
      const timeline = row.timeline;

      this.ctx.strokeStyle = STAGE_COLORS.idle;
      this.ctx.lineWidth = 5;
      this.ctx.beginPath();
      this.ctx.moveTo(layout.left, centerY);
      this.ctx.lineTo(this.valueX(timeline.start, maxValue, layout), centerY);
      this.ctx.stroke();

      this.drawStage(timeline.dnsStart, timeline.dnsEnd, maxValue, layout, y, STAGE_COLORS.dns);
      this.drawStage(timeline.connectStart, timeline.connectEnd, maxValue, layout, y, STAGE_COLORS.connect);
      this.drawStage(timeline.requestStart, timeline.responseStart, maxValue, layout, y, STAGE_COLORS.request);
      this.drawStage(timeline.responseStart, timeline.responseEnd, maxValue, layout, y, STAGE_COLORS.download);

      const businessX = this.valueX(timeline.businessStart, maxValue, layout);
      this.ctx.strokeStyle = STAGE_COLORS.business;
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(businessX, y - 2);
      this.ctx.lineTo(businessX, y + layout.barHeight + 2);
      this.ctx.stroke();

      this.ctx.fillStyle = '#0f172a';
      this.ctx.font = '800 12px system-ui, sans-serif';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(formatMs(timeline.end), this.valueX(timeline.end, maxValue, layout) + 7, centerY);

      this.hitAreas.push({
        key: row.key,
        x: layout.left,
        y,
        w: this.width - layout.left - layout.right,
        h: layout.barHeight,
        row
      });
    });

    this.drawLabels(rows, layout);
    this.drawWaterfallLegend();
    this.drawWaterfallTooltip(rows, layout);
  }

  drawStage(start, end, maxValue, layout, y, color) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const x1 = this.valueX(start, maxValue, layout);
    const x2 = this.valueX(end, maxValue, layout);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x1, y + 5, Math.max(2, x2 - x1), 16);
  }

  drawWaterfallLegend() {
    const items = [
      ['提前量', STAGE_COLORS.idle],
      ['DNS', STAGE_COLORS.dns],
      ['连接', STAGE_COLORS.connect],
      ['请求等待', STAGE_COLORS.request],
      ['下载', STAGE_COLORS.download],
      ['业务取用', STAGE_COLORS.business]
    ];
    let x = 22;
    this.ctx.font = '700 12px system-ui, sans-serif';
    this.ctx.textBaseline = 'middle';
    items.forEach(([label, color]) => {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x, this.height - 18, 12, 12);
      this.ctx.fillStyle = '#475569';
      this.ctx.textAlign = 'left';
      this.ctx.fillText(label, x + 17, this.height - 12);
      x += this.ctx.measureText(label).width + 34;
    });
  }

  drawTooltip(rows) {
    if (!this.hover) return;
    const row = rows.find(item => item.key === this.hover);
    if (!row) return;
    const stats = row.stats;
    const lines = [
      row.label,
      `中位数：${formatMetric(this.metricId, stats.median)}`,
      `P95：${formatMetric(this.metricId, stats.p95)}`,
      `范围：${formatMetric(this.metricId, stats.min)} - ${formatMetric(this.metricId, stats.max)}`,
      `标准差：${this.getMetric().unit === 'B' ? formatBytes(stats.stddev) : formatMs(stats.stddev)}`,
      `相对基线：${formatPercent(stats.vsBaseline)}`,
      `成功/失败：${row.strategy.successCount}/${row.strategy.failureCount}`
    ];
    this.drawTooltipBox(lines);
  }

  drawWaterfallTooltip(rows) {
    if (!this.hover) return;
    const row = rows.find(item => item.key === this.hover);
    if (!row) return;
    const timeline = row.timeline;
    const lines = [
      row.label,
      `提示开始：${formatMs(timeline.start)}`,
      `业务取用：${formatMs(timeline.businessStart)}`,
      `DNS：${formatMs(timeline.dns)} · 连接：${formatMs(timeline.connect)}`,
      `请求等待：${formatMs(timeline.request)} · 下载：${formatMs(timeline.download)}`,
      `最终完成：${formatMs(timeline.end)}`
    ];
    this.drawTooltipBox(lines);
  }

  drawTooltipBox(lines) {
    const padding = 12;
    const lineHeight = 19;
    const textWidth = Math.max(...lines.map((line, index) => {
      this.ctx.font = index === 0 ? '850 13px system-ui, sans-serif' : '650 12px system-ui, sans-serif';
      return this.ctx.measureText(line).width;
    }));
    const width = textWidth + padding * 2;
    const height = lines.length * lineHeight + padding * 1.5;
    const x = Math.min(this.width - width - 10, Math.max(10, this.width - width - 18));
    const y = Math.min(this.height - height - 34, 64);

    this.ctx.save();
    this.ctx.shadowColor = 'rgba(15, 23, 42, 0.22)';
    this.ctx.shadowBlur = 18;
    this.ctx.shadowOffsetY = 5;
    roundedRect(this.ctx, x, y, width, height, 12);
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    this.ctx.fill();
    this.ctx.restore();

    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    lines.forEach((line, index) => {
      this.ctx.fillStyle = index === 0 ? '#ffffff' : '#cbd5e1';
      this.ctx.font = index === 0 ? '850 13px system-ui, sans-serif' : '650 12px system-ui, sans-serif';
      this.ctx.fillText(line, x + padding, y + padding + index * lineHeight);
    });
  }

  toPngBlob() {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas PNG 导出失败'));
      }, 'image/png');
    });
  }
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '改善 ' : value < 0 ? '劣化 ' : '';
  return `${prefix}${Math.abs(value).toFixed(1)}%`;
}

function emptyStats() {
  return {
    values: [],
    count: 0,
    min: null,
    max: null,
    mean: null,
    median: null,
    p95: null,
    stddev: null,
    vsBaseline: null
  };
}
