# Kiwix's mirrors and CORS

vrlbry reads ZIM files from the web in place, a few kilobytes at a time, so that a book or an
article opens without downloading the whole file. That needs one thing from the server that
holds the file. This page explains what, for anyone who runs one of Kiwix's mirrors or would
like to ask their operators.

A web page may read a file from another site only when that site's answer says it may, with
CORS headers (Cross-Origin Resource Sharing). Downloads don't need them (a browser's download,
curl, torrent clients, Kiwix's own apps), but a page that reads a ZIM in place does. Of the seven
mirrors that `download.kiwix.org` sends people to, only Kiwix's own sends them (checked
2026-10-10):

| Mirror | Where | CORS |
|---|---|---|
| `mirror.download.kiwix.org` | France | yes |
| `ftp.nluug.nl` | the Netherlands | no |
| `wi.mirror.driftle.ss`, `ny.mirror.driftle.ss` | United States | no |
| `dumps.wikimedia.org` | United States | no |
| `ftpmirror.your.org` | United States | no |
| `mirror-sites-in.mblibrary.info` | India | no |

All seven serve range requests, and Kiwix's own redirects already send the headers:
`download.kiwix.org` sends a browser to `lb.download.kiwix.org`, which picks a mirror near the
visitor (for California, `wi.mirror.driftle.ss`). The browser only stops at the last step,
because the mirror sends no headers. So the headers on the mirrors are all that is missing.

So every visitor reads from France, however far away. From California a read takes 160-180 ms
there and 80-90 ms from a US mirror. The 49 GB top-million Wikipedia opens in 2.4-4.3 s instead
of 0.7-0.8 s, and finding an article in it takes 7.4 s instead of 3.4 s. An edge proxy
([DEVELOPMENT.md](DEVELOPMENT.md#reading-zims-from-the-web)) works around this, but someone has
to run it. If the mirrors sent the headers, every page that reads
ZIMs in the browser would get the speed with no proxy at all. If you run one of these mirrors,
or would like to ask their operators or Kiwix (who keeps the list), here is what it takes.

The response headers, as Kiwix's mirror sends them:

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
```

A page that sends a `Range` header first asks with an `OPTIONS` request (a preflight). That
request needs an answer (204 or 200) with:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Range
Access-Control-Max-Age: 86400
```

In nginx (five of the six), add this to the `location` that serves the Kiwix files (its path
differs per mirror). The headers are repeated inside the `if` because nginx drops the outer
`add_header`s there:

```nginx
location /kiwix/ {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges" always;
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
        add_header Access-Control-Allow-Headers "Range";
        add_header Access-Control-Max-Age "86400";
        return 204;
    }
}
```

In Apache (with mod_headers), in the `<Directory>` or `<Location>` that serves them:

```apache
Header always set Access-Control-Allow-Origin "*"
Header always set Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges"
Header always set Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
Header always set Access-Control-Allow-Headers "Range"
```

This is safe for a public file mirror:
- `Access-Control-Allow-Origin: *` without credentials lets a page read only what anyone can
  already download. No cookies or logins are sent, and nothing else about the server changes.
- The traffic is range reads of a few kilobytes each, not whole files. Opening a book or an
  article takes a few dozen of them.

To check a mirror, send it a preflight:

```bash
curl -i -X OPTIONS -H "Origin: https://example.org" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" https://mirror.download.kiwix.org/zim/gutenberg/gutenberg_en_lcc-p_2026-03.zim
```

Kiwix's mirror answers `204 No Content` with the headers above. Today the nginx mirrors answer
`405 Not Allowed`, and the Apache one answers `200 OK` without them.

With the headers on the mirrors, no proxy would be needed: a page could follow Kiwix's redirect
once to learn the mirror chosen for its visitor, then read that mirror directly.
