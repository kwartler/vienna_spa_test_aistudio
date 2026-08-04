// GenAI Finance course, starter scaffold.
// This file intentionally does very little. Build on it during class.
//
// No API keys are stored in this file. Both the Twelve Data key and the
// OpenRouter key are entered in the form fields at run time, so nothing secret
// is ever committed to your public repo or shipped in the source.

import * as echarts from 'echarts';
import html2pdf from 'html2pdf.js';

const form = document.getElementById('ticker-form');
const results = document.getElementById('results');

let currentChart = null;
let currentResizeObserver = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  const twelveDataKey = document.getElementById('twelvedata-key').value.trim();
  const newsDataKey = document.getElementById('newsdata-key')?.value.trim() || '';
  const openRouterKey = document.getElementById('openrouter-key').value.trim();

  // Clean up previous chart if active
  if (currentChart) {
    currentChart.dispose();
    currentChart = null;
  }
  if (currentResizeObserver) {
    currentResizeObserver.disconnect();
    currentResizeObserver = null;
  }

  results.innerHTML = '<p class="placeholder">Fetching market data, indicators & headlines...</p>';

  try {
    const { priceData: rawPriceData, companyName } = await fetchPriceData(ticker, twelveDataKey);
    const priceData = calculateIndicators(rawPriceData);

    let newsHeadlines = null;
    let newsError = null;
    if (newsDataKey) {
      try {
        newsHeadlines = await fetchNewsHeadlines(ticker, newsDataKey, companyName);
      } catch (err) {
        newsError = err.message;
      }
    }

    let note = null;
    let perplexityAnalysis = null;

    if (openRouterKey) {
      // Step 1: Run Perplexity Sonar web search analysis on news headlines first
      if (newsHeadlines && newsHeadlines.length > 0) {
        try {
          perplexityAnalysis = await getPerplexityNewsAnalysis(ticker, newsHeadlines, openRouterKey, companyName);
        } catch (err) {
          perplexityAnalysis = `Perplexity Analysis unavailable: ${err.message}`;
        }
      }

      // Step 2: Pass stock data, MACD, RSI, news headlines, and Perplexity SWOT analysis into getResearchNote
      try {
        note = await getResearchNote(ticker, priceData, openRouterKey, newsHeadlines, companyName, perplexityAnalysis);
      } catch (err) {
        note = `AI Note unavailable: ${err.message}`;
      }
    }

    renderResults(ticker, priceData, note, newsHeadlines, newsError, companyName, perplexityAnalysis);
  } catch (err) {
    results.innerHTML = `<p class="error">Something went wrong: ${err.message}</p>`;
  }
});

// Twelve Data daily price history.
// Fetch outputsize=300 (~1.2 years) for rich candlestick chart history.
async function fetchPriceData(ticker, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=300&apikey=${apiKey}`;
  const response = await fetch(url);

  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(body.trim() || 'Price fetch failed');
  }

  if (raw && raw.status === 'error') throw new Error(raw.message || 'Price fetch failed');
  if (!response.ok) throw new Error('Price fetch failed');

  const values = raw.values ?? [];
  if (!values.length) throw new Error(`No price data returned for ${ticker}`);

  const companyName = raw.meta?.name || '';

  const priceData = values
    .map((b) => ({
      date: b.datetime,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume || 0)
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { priceData, companyName };
}

/**
 * NewsData.io headlines fetcher using the market news endpoint.
 * GET request: https://newsdata.io/api/1/market?apikey=YOUR_KEY&q="COMPANY"
 */
async function fetchNewsHeadlines(ticker, apiKey, companyName = '') {
  if (!apiKey) return null;

  let query = ticker;
  if (companyName) {
    const cleanName = companyName
      .replace(/\b(Inc\.?|Corporation|Corp\.?|Co\.?|Ltd\.?|LLC|Class\s+[A-Z0-9]+|Common\s+Stock|ADR|Plc|Group|Holdings|N\.?V\.?)\b/gi, '')
      .replace(/[,.-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanName && cleanName.length > 1) {
      query = `"${cleanName}"`;
    }
  }

  const url = `https://newsdata.io/api/1/market?apikey=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&language=en&prioritydomain=top`;
  const response = await fetch(url);

  const body = await response.text();
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error('Could not parse NewsData.io response.');
  }

  if (raw.status === 'error' || (raw.results && raw.results.message)) {
    const errorMsg = raw.results?.message || raw.message || 'NewsData.io request failed';
    throw new Error(errorMsg);
  }

  const articles = raw.results ?? [];
  if (!articles.length) return [];

  return articles.slice(0, 8).map((art) => ({
    title: art.title || 'Untitled Article',
    link: art.link || '#',
    source: art.source_id || art.source_url || 'News',
    pubDate: art.pubDate || '',
    description: art.description || art.content || '',
    imageUrl: art.image_url || null,
  }));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Calculates MACD (12, 26, 9) and RSI (14) for the price series.
 * Returns array enriched with macd, signal, histogram, and rsi.
 */
function calculateIndicators(priceData) {
  const closes = priceData.map((d) => d.close);
  const len = closes.length;

  function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    const ema = new Array(data.length).fill(null);
    if (data.length < period) return ema;

    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    let prevEMA = sum / period;
    ema[period - 1] = prevEMA;

    for (let i = period; i < data.length; i++) {
      const currentEMA = data[i] * k + prevEMA * (1 - k);
      ema[i] = currentEMA;
      prevEMA = currentEMA;
    }
    return ema;
  }

  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  const macdLine = new Array(len).fill(null);
  const macdValList = [];
  const macdIdxList = [];

  for (let i = 0; i < len; i++) {
    if (ema12[i] !== null && ema26[i] !== null) {
      const val = ema12[i] - ema26[i];
      macdLine[i] = val;
      macdValList.push(val);
      macdIdxList.push(i);
    }
  }

  const signalEMA = calculateEMA(macdValList, 9);
  const signalLine = new Array(len).fill(null);
  const histogram = new Array(len).fill(null);

  for (let idx = 0; idx < macdValList.length; idx++) {
    const origIndex = macdIdxList[idx];
    if (signalEMA[idx] !== null) {
      signalLine[origIndex] = signalEMA[idx];
      histogram[origIndex] = macdLine[origIndex] - signalEMA[idx];
    }
  }

  // RSI 14 calculation (Wilder's Smoothing)
  const rsi = new Array(len).fill(null);
  const periodRSI = 14;

  if (len > periodRSI) {
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= periodRSI; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    let avgGain = gains / periodRSI;
    let avgLoss = losses / periodRSI;

    if (avgLoss === 0) {
      rsi[periodRSI] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[periodRSI] = 100 - 100 / (1 + rs);
    }

    for (let i = periodRSI + 1; i < len; i++) {
      const diff = closes[i] - closes[i - 1];
      const currentGain = diff > 0 ? diff : 0;
      const currentLoss = diff < 0 ? Math.abs(diff) : 0;

      avgGain = (avgGain * (periodRSI - 1) + currentGain) / periodRSI;
      avgLoss = (avgLoss * (periodRSI - 1) + currentLoss) / periodRSI;

      if (avgLoss === 0) {
        rsi[i] = 100;
      } else {
        const rs = avgGain / avgLoss;
        rsi[i] = 100 - 100 / (1 + rs);
      }
    }
  }

  return priceData.map((d, i) => ({
    ...d,
    macd: macdLine[i],
    signal: signalLine[i],
    histogram: histogram[i],
    rsi: rsi[i],
  }));
}

// Helper to format basic markdown (bold, italic, headers, list items, paragraphs) into clean HTML
function formatMarkdownOrText(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = html.split('\n');
  let result = '';
  let inList = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### ')) {
      if (inList) { result += '</ul>'; inList = false; }
      result += `<h4>${trimmed.substring(4)}</h4>`;
    } else if (trimmed.startsWith('## ')) {
      if (inList) { result += '</ul>'; inList = false; }
      result += `<h3>${trimmed.substring(3)}</h3>`;
    } else if (trimmed.startsWith('# ')) {
      if (inList) { result += '</ul>'; inList = false; }
      result += `<h2>${trimmed.substring(2)}</h2>`;
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        result += '<ul>';
        inList = true;
      }
      result += `<li>${trimmed.substring(2)}</li>`;
    } else {
      if (inList) {
        result += '</ul>';
        inList = false;
      }
      if (trimmed) {
        result += `<p>${trimmed}</p>`;
      }
    }
  }
  if (inList) {
    result += '</ul>';
  }
  return result;
}

// OpenRouter call. The price data and technical indicators are summarized and handed to the model
// so the research note reflects the actual numbers fetched and calculated.
async function getResearchNote(ticker, priceData, apiKey, newsHeadlines = null, companyName = '', perplexityAnalysis = null) {
  const first = priceData[0];
  const latest = priceData[priceData.length - 1];
  const previous = priceData.length > 1 ? priceData[priceData.length - 2] : null;

  const pctChange = ((latest.close - first.close) / first.close) * 100;
  const dayChange = previous ? latest.close - previous.close : latest.close - latest.open;
  const dayPct = previous ? (dayChange / previous.close) * 100 : ((latest.close - latest.open) / latest.open) * 100;

  const rsiVal = latest.rsi !== null ? latest.rsi.toFixed(2) : 'N/A';
  const macdVal = latest.macd !== null ? latest.macd.toFixed(2) : 'N/A';
  const signalVal = latest.signal !== null ? latest.signal.toFixed(2) : 'N/A';
  const histVal = latest.histogram !== null ? latest.histogram.toFixed(2) : 'N/A';

  let newsContext = '';
  if (newsHeadlines && newsHeadlines.length > 0) {
    newsContext = '\n\nRecent Market Headlines:\n' +
      newsHeadlines.slice(0, 5).map(h => `- ${h.title} (${h.source})`).join('\n');
  }

  let perplexityContext = '';
  if (perplexityAnalysis) {
    const perpText = typeof perplexityAnalysis === 'string' ? perplexityAnalysis : perplexityAnalysis.content;
    if (perpText) {
      perplexityContext = '\n\nPerplexity Headlines Implication & SWOT Analysis:\n' + perpText;
    }
  }

  const subjectName = companyName ? `${companyName} (${ticker})` : ticker;

  const summary = `
Financial & Technical Market Data for ${subjectName}:
- Date Range Analyzed: ${first.date} to ${latest.date} (${priceData.length} trading days)
- Overall Range Performance: Start $${first.close.toFixed(2)} -> Latest $${latest.close.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%)
- Latest Session (${latest.date}):
  * Open: $${latest.open.toFixed(2)}
  * High: $${latest.high.toFixed(2)}
  * Low: $${latest.low.toFixed(2)}
  * Close: $${latest.close.toFixed(2)}
  * Single-day Change: ${dayChange >= 0 ? '+' : ''}$${dayChange.toFixed(2)} (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)
  * Volume: ${latest.volume ? latest.volume.toLocaleString() : 'N/A'}
- Technical Indicators (Calculated for Latest Session):
  * Relative Strength Index (RSI 14): ${rsiVal} (${latest.rsi !== null ? (latest.rsi >= 70 ? 'Overbought signal > 70' : latest.rsi <= 30 ? 'Oversold signal < 30' : 'Neutral territory 30-70') : 'N/A'})
  * MACD Line (12,26): ${macdVal}
  * MACD Signal Line (9): ${signalVal}
  * MACD Histogram: ${histVal} (${latest.histogram !== null ? (latest.histogram >= 0 ? 'Bullish momentum (histogram >= 0)' : 'Bearish momentum (histogram < 0)') : 'N/A'})${newsContext}${perplexityContext}
  `;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      max_tokens: 1000,
      messages: [
        {
          role: 'system',
          content: 'You are a professional financial research analyst. Write a concise, insightful research note analyzing the provided ticker data. Synthesize price trends, single-day session action, technical indicators (RSI & MACD), news headlines, and the Perplexity Sonar SWOT analysis into actionable insights.'
        },
        {
          role: 'user',
          content: `${summary}\n\nIMPORTANT FORMATTING INSTRUCTION:\nOn the very first line of your response, output an overall signal rating tag in the exact format:\nRATING: BUY\nor\nRATING: NEUTRAL\nor\nRATING: SELL\n(Use SELL for definite sell signals, NEUTRAL for hold/neutral, BUY for bullish signals).\n\nThen add a blank line and write your two-paragraph AI Research Note for ${subjectName} synthesizing stock price performance, technical signals (RSI/MACD), news headlines, and the Perplexity SWOT implications.`
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`OpenRouter call failed. ${await readOpenRouterError(response)}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? 'No response returned from model.';
}

// OpenRouter call using perplexity/sonar to analyze news headlines & perform web search
async function getPerplexityNewsAnalysis(ticker, newsHeadlines, apiKey, companyName = '') {
  if (!apiKey || !newsHeadlines || newsHeadlines.length === 0) return null;

  const subjectName = companyName ? `${companyName} (${ticker})` : ticker;
  const headlinesFormatted = newsHeadlines
    .map((h, i) => `${i + 1}. "${h.title}" (Source: ${h.source}${h.pubDate ? `, Date: ${h.pubDate}` : ''})${h.description ? ` - ${h.description}` : ''}`)
    .join('\n');

  const prompt = `Target Company: ${subjectName}

Here are the current market news headlines retrieved for the company:
${headlinesFormatted}

Please perform a real-time web search and provide:

### Implication of Headlines on the Company
Write a clear, thorough narrative analyzing how these recent news headlines and current developments specifically impact or may impact ${subjectName}, its business operations, financial drivers, and stock sentiment. Include inline bracket citations (e.g. [1], [2], [6]) referencing the source articles.

### SWOT Analysis
If these headlines and news impact the stock, provide a bulleted list of SWOT with exactly ONE bullet point for each category, directly tied to how current news/events affect the company:
- **Strength**: (one bullet point)
- **Weakness**: (one bullet point)
- **Opportunity**: (one bullet point)
- **Threat**: (one bullet point)`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'perplexity/sonar',
      max_tokens: 1000,
      messages: [
        {
          role: 'system',
          content: 'You are a senior equity research analyst and market intelligence expert with real-time web search capability. Use inline bracket citations like [1], [2], [6] when referencing facts from sources.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`OpenRouter Perplexity call failed. ${await readOpenRouterError(response)}`);
  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content ?? 'No analysis returned from Perplexity.';
  const citations = data.citations || data.choices?.[0]?.citations || data.choices?.[0]?.message?.citations || [];

  return {
    content: rawContent,
    citations: citations
  };
}

// Pulls the useful part out of an OpenRouter error response: the HTTP status,
// a plain-language hint for the common cases, and the message OpenRouter (or
// the upstream provider) actually returned.
async function readOpenRouterError(response) {
  let message = '';
  try {
    const body = await response.json();
    const err = body.error ?? body;
    message = err.message || '';
    const provider = err.metadata?.provider_name;
    const raw = err.metadata?.raw;
    if (provider) message += ` [provider: ${provider}]`;
    if (raw) message += ` ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`;
  } catch {
    // Response body was not JSON
  }
  const hint = {
    401: 'Your API key looks invalid or missing',
    402: 'This model is paid and your OpenRouter account is out of credits',
    429: 'Rate limited, wait a moment and try again'
  }[response.status];
  return [`(HTTP ${response.status})`, hint, message].filter(Boolean).join(' ');
}

// Formats Perplexity output with interactive citation links and sources list
function renderPerplexityAnalysisCard(perplexityAnalysis, newsHeadlines) {
  if (!perplexityAnalysis) {
    return `<p class="note-placeholder"><em>Provide an OpenRouter API Key in the form above to generate Perplexity Sonar news implications and SWOT analysis.</em></p>`;
  }

  let text = '';
  let citations = [];

  if (typeof perplexityAnalysis === 'string') {
    text = perplexityAnalysis;
  } else if (typeof perplexityAnalysis === 'object') {
    text = perplexityAnalysis.content || '';
    citations = perplexityAnalysis.citations || [];
  }

  function getCitationUrl(num) {
    const idx = num - 1;
    if (Array.isArray(citations) && citations[idx] && typeof citations[idx] === 'string') {
      return citations[idx];
    }
    if (Array.isArray(newsHeadlines) && newsHeadlines[idx] && newsHeadlines[idx].link) {
      return newsHeadlines[idx].link;
    }
    return null;
  }

  let htmlContent = formatMarkdownOrText(text);

  // First handle multi/comma citations e.g. [1, 2] or [2, 6]
  htmlContent = htmlContent.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (match, group) => {
    const nums = group.split(',').map(s => s.trim());
    return nums.map(nStr => {
      const num = parseInt(nStr, 10);
      const url = getCitationUrl(num);
      if (url) {
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="perplexity-citation-link" title="Open citation [${num}] in new tab">[${num}]</a>`;
      }
      return `<span class="perplexity-citation-tag">[${num}]</span>`;
    }).join('');
  });

  // Next handle single or adjacent citations e.g. [1] or [2][6]
  htmlContent = htmlContent.replace(/\[(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    const url = getCitationUrl(num);
    if (url) {
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="perplexity-citation-link" title="Open citation [${num}] in new tab">[${num}]</a>`;
    }
    return `<span class="perplexity-citation-tag">[${num}]</span>`;
  });

  let citationsListHtml = '';
  const effectiveCitations = (citations && citations.length > 0)
    ? citations
    : (newsHeadlines || []).map(h => h.link).filter(Boolean);

  if (effectiveCitations && effectiveCitations.length > 0) {
    const itemsHtml = effectiveCitations.map((url, idx) => {
      let domain = url;
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        // Fallback
      }
      return `<li><span class="citation-num">[${idx + 1}]</span> <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="perplexity-source-link">${escapeHtml(domain)} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a></li>`;
    }).join('');

    citationsListHtml = `
      <div class="perplexity-sources-box">
        <h5>Search Sources & Citations</h5>
        <ul class="perplexity-sources-list">${itemsHtml}</ul>
      </div>
    `;
  }

  return `<div class="perplexity-body">${htmlContent}</div>${citationsListHtml}`;
}

function renderResults(ticker, priceData, note, newsHeadlines = null, newsError = null, companyName = '', perplexityAnalysis = null) {
  const latest = priceData[priceData.length - 1];
  const previous = priceData.length > 1 ? priceData[priceData.length - 2] : null;

  let rating = 'NEUTRAL';
  let cleanedNote = note;

  if (note) {
    const ratingMatch = note.match(/RATING:\s*(BUY|NEUTRAL|SELL)/i);
    if (ratingMatch) {
      rating = ratingMatch[1].toUpperCase();
      cleanedNote = note.replace(/RATING:\s*(BUY|NEUTRAL|SELL)\s*/i, '').trim();
    } else {
      if (/definite sell|strong sell|sell signal|\bsell\b/i.test(note)) rating = 'SELL';
      else if (/strong buy|buy signal|\bbuy\b/i.test(note)) rating = 'BUY';
    }
  } else if (priceData && priceData.length > 0) {
    const latestBar = priceData[priceData.length - 1];
    if (latestBar && latestBar.rsi !== null && latestBar.histogram !== null) {
      if (latestBar.rsi < 38 && latestBar.histogram > 0) rating = 'BUY';
      else if (latestBar.rsi > 65 && latestBar.histogram < 0) rating = 'SELL';
    }
  }

  const headerTitle = companyName ? `${ticker} (${companyName})` : ticker;

  const dollarChange = previous ? latest.close - previous.close : latest.close - latest.open;
  const percentChange = previous ? (dollarChange / previous.close) * 100 : ((latest.close - latest.open) / latest.open) * 100;
  const isPositive = dollarChange >= 0;
  const changeClass = isPositive ? 'pos' : 'neg';
  const changeSign = isPositive ? '+' : '';

  const minDate = priceData[0].date;
  const maxDate = priceData[priceData.length - 1].date;

  const recentHistory = [...priceData].reverse().slice(0, 15);

  const historyRows = recentHistory.map((bar, idx) => {
    const prevBar = recentHistory[idx + 1];
    let rowChange = 0;
    let rowPct = 0;
    if (prevBar) {
      rowChange = bar.close - prevBar.close;
      rowPct = (rowChange / prevBar.close) * 100;
    } else {
      rowChange = bar.close - bar.open;
      rowPct = (rowChange / bar.open) * 100;
    }
    const rowClass = rowChange >= 0 ? 'pos' : 'neg';
    const rowSign = rowChange >= 0 ? '+' : '';

    return `
      <tr>
        <td class="col-date">${bar.date}</td>
        <td class="col-num">$${bar.open.toFixed(2)}</td>
        <td class="col-num">$${bar.high.toFixed(2)}</td>
        <td class="col-num">$${bar.low.toFixed(2)}</td>
        <td class="col-num"><strong>$${bar.close.toFixed(2)}</strong></td>
        <td class="col-num ${rowClass}">${rowSign}$${rowChange.toFixed(2)} (${rowSign}${rowPct.toFixed(2)}%)</td>
        <td class="col-num">${bar.volume ? bar.volume.toLocaleString() : 'N/A'}</td>
        <td class="col-num">${bar.rsi !== null ? bar.rsi.toFixed(1) : '-'}</td>
        <td class="col-num">${bar.macd !== null ? bar.macd.toFixed(2) : '-'}</td>
      </tr>
    `;
  }).join('');

  const newsContentHtml = newsHeadlines && newsHeadlines.length > 0
    ? `<div class="news-grid">
        ${newsHeadlines.map((item) => `
          <div class="news-card">
            <div class="news-card-meta">
              <span class="news-source">${escapeHtml(item.source)}</span>
              ${item.pubDate ? `<span class="news-date">${escapeHtml(item.pubDate)}</span>` : ''}
            </div>
            <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" class="news-title">${escapeHtml(item.title)}</a>
            ${item.description ? `<p class="news-desc">${escapeHtml(item.description.length > 150 ? item.description.substring(0, 150) + '...' : item.description)}</p>` : ''}
          </div>
        `).join('')}
      </div>`
    : newsError
      ? `<p class="error-text">Could not fetch news headlines: ${escapeHtml(newsError)}</p>`
      : `<p class="note-placeholder"><em>Provide a NewsData.io API Key in the form above to fetch market headlines for ${escapeHtml(ticker)}.</em></p>`;

  results.innerHTML = `
    <div class="result-header">
      <h2>${escapeHtml(headerTitle)} OHLC & Indicator Analysis</h2>
      <span class="latest-date">Latest Session: ${latest.date}</span>
    </div>

    <div class="ohlc-hero">
      <div class="hero-price">
        <span class="label">Latest Close</span>
        <span class="value">$${latest.close.toFixed(2)}</span>
      </div>
      <div class="hero-change ${changeClass}">
        <span class="label">Day Change</span>
        <span class="value">${changeSign}$${dollarChange.toFixed(2)} (${changeSign}${percentChange.toFixed(2)}%)</span>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-header">
        <h3>Interactive Candlestick, MACD & RSI Charts</h3>
        <div class="date-range-bar">
          <div class="preset-buttons">
            <button type="button" class="range-btn" data-range="1M">1M</button>
            <button type="button" class="range-btn active" data-range="3M">3M</button>
            <button type="button" class="range-btn" data-range="6M">6M</button>
            <button type="button" class="range-btn" data-range="1Y">1Y</button>
            <button type="button" class="range-btn" data-range="YTD">YTD</button>
            <button type="button" class="range-btn" data-range="ALL">ALL</button>
          </div>
          <div class="custom-date-picker">
            <label for="start-date-input">From:</label>
            <input type="date" id="start-date-input" min="${minDate}" max="${maxDate}">
            <label for="end-date-input">To:</label>
            <input type="date" id="end-date-input" min="${minDate}" max="${maxDate}">
            <button type="button" id="apply-custom-dates">Set</button>
          </div>
        </div>
      </div>

      <div id="chart-legend" class="chart-legend"></div>
      <div id="candlestick-chart-container" class="candlestick-chart-container"></div>
    </div>

    <div class="ohlc-grid">
      <div class="metric-card">
        <span class="metric-label">Open</span>
        <span class="metric-value">$${latest.open.toFixed(2)}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">High</span>
        <span class="metric-value">$${latest.high.toFixed(2)}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Low</span>
        <span class="metric-value">$${latest.low.toFixed(2)}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Close</span>
        <span class="metric-value">$${latest.close.toFixed(2)}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Volume</span>
        <span class="metric-value">${latest.volume ? latest.volume.toLocaleString() : 'N/A'}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">RSI (14)</span>
        <span class="metric-value ${latest.rsi !== null ? (latest.rsi >= 70 ? 'neg' : latest.rsi <= 30 ? 'pos' : '') : ''}">${latest.rsi !== null ? latest.rsi.toFixed(2) : 'N/A'}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">MACD Line</span>
        <span class="metric-value ${latest.macd !== null ? (latest.macd >= 0 ? 'pos' : 'neg') : ''}">${latest.macd !== null ? latest.macd.toFixed(2) : 'N/A'}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">MACD Signal</span>
        <span class="metric-value">${latest.signal !== null ? latest.signal.toFixed(2) : 'N/A'}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">MACD Hist</span>
        <span class="metric-value ${latest.histogram !== null ? (latest.histogram >= 0 ? 'pos' : 'neg') : ''}">${latest.histogram !== null ? latest.histogram.toFixed(2) : 'N/A'}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Session Range</span>
        <span class="metric-value">$${latest.low.toFixed(2)} - $${latest.high.toFixed(2)}</span>
      </div>
    </div>

    <div class="history-section">
      <h3>Recent Daily OHLC History</h3>
      <div class="table-wrapper">
        <table class="ohlc-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Open</th>
              <th>High</th>
              <th>Low</th>
              <th>Close</th>
              <th>Change</th>
              <th>Volume</th>
              <th>RSI(14)</th>
              <th>MACD</th>
            </tr>
          </thead>
          <tbody>
            ${historyRows}
          </tbody>
        </table>
      </div>
    </div>

    <div class="news-section">
      <h3>Latest News Headlines for ${escapeHtml(ticker)}</h3>
      <p class="news-endpoint-subtitle"><em>Retrieved from https://newsdata.io/api/1/market endpoint (filtered by top priority domains: prioritydomain=top)</em></p>
      ${newsContentHtml}

      ${
        newsHeadlines && newsHeadlines.length > 0 ? `
          <div class="perplexity-analysis-card">
            <div class="perplexity-header">
              <h4>Implication of Headlines on the Company</h4>
              <span class="perplexity-badge">Perplexity Sonar Web Search</span>
            </div>
            ${renderPerplexityAnalysisCard(perplexityAnalysis, newsHeadlines)}
          </div>
        ` : ''
      }
    </div>

    <div class="note-box">
      <h3>AI Research Note</h3>
      <div class="traffic-light-pill traffic-${rating.toLowerCase()}">
        <div class="traffic-lights">
          <span class="light red ${rating === 'SELL' ? 'active' : ''}" title="Red: Definite SELL Signal"></span>
          <span class="light yellow ${rating === 'NEUTRAL' ? 'active' : ''}" title="Yellow: NEUTRAL Signal"></span>
          <span class="light green ${rating === 'BUY' ? 'active' : ''}" title="Green: BUY Signal"></span>
        </div>
        <span class="traffic-label">${rating === 'SELL' ? 'SELL SIGNAL' : rating === 'BUY' ? 'BUY SIGNAL' : 'NEUTRAL / HOLD'}</span>
      </div>
      ${
        cleanedNote
          ? `<div class="note-body">${formatMarkdownOrText(cleanedNote)}</div>`
          : `<p class="note-placeholder"><em>Provide an OpenRouter API Key in the form above to generate an automated AI Research Note analyzing OHLC, MACD, RSI data, and headlines.</em></p>`
      }
    </div>

    <div class="pdf-download-container" data-html2canvas-ignore="true">
      <button type="button" id="download-pdf-btn" class="download-pdf-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download Research Note PDF
      </button>
    </div>
  `;

  initCandlestickChart(priceData);
  initPdfDownload(ticker);
}

function initPdfDownload(ticker) {
  const downloadBtn = document.getElementById('download-pdf-btn');
  if (!downloadBtn) return;

  downloadBtn.addEventListener('click', async () => {
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = `
      <svg class="spin-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
        <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
      </svg>
      Generating PDF Report...
    `;

    try {
      const element = document.getElementById('results');
      const dateStr = new Date().toISOString().split('T')[0];
      const opt = {
        margin: [0.35, 0.4, 0.4, 0.4],
        filename: `${ticker}_Research_Report_${dateStr}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
      };

      await html2pdf().set(opt).from(element).save();
    } catch (err) {
      console.error('Failed to generate PDF:', err);
      alert('Could not download PDF: ' + err.message);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = originalHtml;
    }
  });
}

function initCandlestickChart(priceData) {
  const container = document.getElementById('candlestick-chart-container');
  const legendEl = document.getElementById('chart-legend');
  const startDateInput = document.getElementById('start-date-input');
  const endDateInput = document.getElementById('end-date-input');
  const applyBtn = document.getElementById('apply-custom-dates');
  const presetBtns = document.querySelectorAll('.range-btn');

  if (!container) return;

  const dates = priceData.map((d) => d.date);
  const ohlcData = priceData.map((d) => [d.open, d.close, d.low, d.high]);
  const volumeData = priceData.map((d) => ({
    value: d.volume,
    itemStyle: {
      color: d.close >= d.open ? 'rgba(27, 122, 58, 0.5)' : 'rgba(166, 48, 44, 0.5)',
    },
  }));

  const macdLineData = priceData.map((d) => (d.macd !== null ? Number(d.macd.toFixed(3)) : null));
  const signalLineData = priceData.map((d) => (d.signal !== null ? Number(d.signal.toFixed(3)) : null));
  const histData = priceData.map((d) => ({
    value: d.histogram !== null ? Number(d.histogram.toFixed(3)) : null,
    itemStyle: {
      color: d.histogram !== null && d.histogram >= 0 ? '#1b7a3a' : '#a6302c',
    },
  }));
  const rsiData = priceData.map((d) => (d.rsi !== null ? Number(d.rsi.toFixed(2)) : null));

  const chart = echarts.init(container);
  currentChart = chart;

  const latestBar = priceData[priceData.length - 1];
  updateLegend(latestBar);

  const option = {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        lineStyle: {
          color: '#8a8577',
          width: 1,
          type: 'dashed',
        },
      },
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#dcd7cc',
      textStyle: {
        color: '#333',
        fontFamily: "'Menlo', 'Courier New', monospace",
        fontSize: 12,
      },
      formatter: function (params) {
        if (!params || !params.length) return '';
        const dataIndex = params[0].dataIndex;
        const bar = priceData[dataIndex];
        if (bar) {
          updateLegend(bar);
        }
        return '';
      },
    },
    grid: [
      { left: '8%', right: '4%', top: '4%', height: '38%' },
      { left: '8%', right: '4%', top: '46%', height: '10%' },
      { left: '8%', right: '4%', top: '60%', height: '14%' },
      { left: '8%', right: '4%', top: '78%', height: '12%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#dcd7cc' } },
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: '#f2eee6' } },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: 'category',
        gridIndex: 2,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#dcd7cc' } },
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: '#f2eee6' } },
      },
      {
        type: 'category',
        gridIndex: 3,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#dcd7cc' } },
        axisLabel: {
          color: '#555',
          fontFamily: "'Menlo', 'Courier New', monospace",
          fontSize: 10,
        },
        splitLine: { show: true, lineStyle: { color: '#f2eee6' } },
      },
    ],
    yAxis: [
      {
        scale: true,
        axisLine: { lineStyle: { color: '#dcd7cc' } },
        axisLabel: {
          color: '#555',
          fontFamily: "'Menlo', 'Courier New', monospace",
          fontSize: 10,
          formatter: (v) => '$' + v.toFixed(2),
        },
        splitLine: { show: true, lineStyle: { color: '#f2eee6' } },
      },
      {
        scale: true,
        gridIndex: 1,
        splitNumber: 2,
        axisLine: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        scale: true,
        gridIndex: 2,
        axisLine: { lineStyle: { color: '#dcd7cc' } },
        axisLabel: {
          color: '#555',
          fontFamily: "'Menlo', 'Courier New', monospace",
          fontSize: 9,
        },
        splitLine: { show: true, lineStyle: { color: '#f2eee6' } },
      },
      {
        min: 0,
        max: 100,
        gridIndex: 3,
        axisLine: { lineStyle: { color: '#dcd7cc' } },
        axisLabel: {
          color: '#555',
          fontFamily: "'Menlo', 'Courier New', monospace",
          fontSize: 9,
        },
        splitLine: { show: true, lineStyle: { color: '#f2eee6' } },
      },
    ],
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: [0, 1, 2, 3],
        start: 70,
        end: 100,
      },
      {
        show: true,
        type: 'slider',
        xAxisIndex: [0, 1, 2, 3],
        top: '94%',
        height: 18,
        start: 70,
        end: 100,
        borderColor: '#dcd7cc',
        fillerColor: 'rgba(27, 122, 58, 0.15)',
        handleStyle: { color: '#1b7a3a' },
        textStyle: { color: '#6b675d', fontFamily: "'Menlo', 'Courier New', monospace", fontSize: 10 },
      },
    ],
    series: [
      {
        name: 'Candlestick',
        type: 'candlestick',
        data: ohlcData,
        itemStyle: {
          color: '#1b7a3a',
          color0: '#a6302c',
          borderColor: '#1b7a3a',
          borderColor0: '#a6302c',
        },
      },
      {
        name: 'Volume',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumeData,
      },
      {
        name: 'MACD',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: macdLineData,
        showSymbol: false,
        lineStyle: { color: '#2563eb', width: 1.5 },
      },
      {
        name: 'Signal',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: signalLineData,
        showSymbol: false,
        lineStyle: { color: '#d97706', width: 1.5 },
      },
      {
        name: 'Histogram',
        type: 'bar',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: histData,
      },
      {
        name: 'RSI',
        type: 'line',
        xAxisIndex: 3,
        yAxisIndex: 3,
        data: rsiData,
        showSymbol: false,
        lineStyle: { color: '#7c3aed', width: 1.5 },
        markLine: {
          symbol: 'none',
          data: [
            { yAxis: 70, lineStyle: { color: '#a6302c', type: 'dashed' } },
            { yAxis: 30, lineStyle: { color: '#1b7a3a', type: 'dashed' } },
          ],
        },
      },
    ],
  };

  chart.setOption(option);

  function updateLegend(bar) {
    const change = bar.close - bar.open;
    const pct = bar.open > 0 ? (change / bar.open) * 100 : 0;
    const sign = change >= 0 ? '+' : '';
    const cls = change >= 0 ? 'pos' : 'neg';

    const rsiTxt = bar.rsi !== null ? bar.rsi.toFixed(1) : 'N/A';
    const macdTxt = bar.macd !== null ? bar.macd.toFixed(2) : 'N/A';
    const sigTxt = bar.signal !== null ? bar.signal.toFixed(2) : 'N/A';

    legendEl.innerHTML = `
      <span class="legend-item"><strong>Date:</strong> ${bar.date}</span>
      <span class="legend-item"><strong>O:</strong> $${bar.open.toFixed(2)}</span>
      <span class="legend-item"><strong>H:</strong> $${bar.high.toFixed(2)}</span>
      <span class="legend-item"><strong>L:</strong> $${bar.low.toFixed(2)}</span>
      <span class="legend-item"><strong>C:</strong> $${bar.close.toFixed(2)}</span>
      <span class="legend-item ${cls}"><strong>Chg:</strong> ${sign}$${change.toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>
      <span class="legend-item"><strong>RSI:</strong> ${rsiTxt}</span>
      <span class="legend-item"><strong>MACD:</strong> ${macdTxt}</span>
      <span class="legend-item"><strong>Sig:</strong> ${sigTxt}</span>
    `;
  }

  function applyPresetRange(rangeKey) {
    const maxBar = priceData[priceData.length - 1];
    const latestDate = new Date(maxBar.date);
    let targetStartDate = new Date(latestDate);

    if (rangeKey === '1M') {
      targetStartDate.setMonth(targetStartDate.getMonth() - 1);
    } else if (rangeKey === '3M') {
      targetStartDate.setMonth(targetStartDate.getMonth() - 3);
    } else if (rangeKey === '6M') {
      targetStartDate.setMonth(targetStartDate.getMonth() - 6);
    } else if (rangeKey === '1Y') {
      targetStartDate.setFullYear(targetStartDate.getFullYear() - 1);
    } else if (rangeKey === 'YTD') {
      targetStartDate = new Date(latestDate.getFullYear(), 0, 1);
    } else if (rangeKey === 'ALL') {
      chart.dispatchAction({
        type: 'dataZoom',
        start: 0,
        end: 100,
      });
      return;
    }

    const startDateStr = targetStartDate.toISOString().split('T')[0];
    let startIdx = priceData.findIndex((d) => d.date >= startDateStr);
    if (startIdx < 0) startIdx = 0;

    chart.dispatchAction({
      type: 'dataZoom',
      startValue: startIdx,
      endValue: priceData.length - 1,
    });
  }

  // Set initial preset to 3M
  applyPresetRange('3M');

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyPresetRange(btn.dataset.range);
    });
  });

  applyBtn.addEventListener('click', () => {
    const sDate = startDateInput.value;
    const eDate = endDateInput.value;
    if (sDate && eDate) {
      let startIdx = priceData.findIndex((d) => d.date >= sDate);
      let endIdx = priceData.length - 1;
      for (let i = priceData.length - 1; i >= 0; i--) {
        if (priceData[i].date <= eDate) {
          endIdx = i;
          break;
        }
      }
      if (startIdx >= 0 && endIdx >= startIdx) {
        chart.dispatchAction({
          type: 'dataZoom',
          startValue: startIdx,
          endValue: endIdx,
        });
        presetBtns.forEach((b) => b.classList.remove('active'));
      }
    }
  });

  chart.on('dataZoom', () => {
    const opt = chart.getOption();
    if (opt && opt.dataZoom && opt.dataZoom[0]) {
      const dz = opt.dataZoom[0];
      const startIdx = typeof dz.startValue !== 'undefined' ? dz.startValue : Math.floor((dz.start / 100) * (priceData.length - 1));
      const endIdx = typeof dz.endValue !== 'undefined' ? dz.endValue : Math.ceil((dz.end / 100) * (priceData.length - 1));

      if (priceData[startIdx]) startDateInput.value = priceData[startIdx].date;
      if (priceData[endIdx]) endDateInput.value = priceData[endIdx].date;
    }
  });

  currentResizeObserver = new ResizeObserver(() => {
    chart.resize();
  });
  currentResizeObserver.observe(container);
}
