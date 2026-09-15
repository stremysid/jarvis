export default {
  async fetch(request) {
    if (new URL(request.url).searchParams.has("redirect")) return new Response(null, { status: 302, headers: { location: "https://other.example/login" } });
    return new Response("stub-outbound reached", { status: 200 });
  }
};
