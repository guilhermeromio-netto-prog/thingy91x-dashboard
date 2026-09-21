export async function handler(event) {
  const path = event.path.replace('/.netlify/functions/nrfcloud', '');
  const query = event.queryStringParameters
    ? '?' + new URLSearchParams(event.queryStringParameters).toString()
    : '';
  const url = `https://api.nrfcloud.com/v1${path}${query}`;

  const headers = {
    Authorization: event.headers.authorization || event.headers.Authorization,
    'X-Team-Id': event.headers['x-team-id'] || event.headers['X-Team-Id'],
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    const res = await fetch(url, {
      method: event.httpMethod,
      headers,
      body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : event.body
    });

    const contentType = res.headers.get('content-type');
    const body = contentType?.includes('application/json')
      ? await res.json()
      : await res.text();

    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Bad gateway', detail: err.message })
    };
  }
}