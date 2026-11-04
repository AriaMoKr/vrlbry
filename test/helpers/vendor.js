// Client modules name the vendor packages by relative URL (../vendor/<name>/…: common's door.js,
// layersharedsession's modules), which the server maps onto node_modules (server/vendor.js). In
// Node there is no such folder, so this maps those URLs the same way, for the tests that import
// such a module. Import it first, then the module under test dynamically, so the mapping is in
// place before that module's imports are resolved:
//
//   import './helpers/vendor.js';
//   const { wayOut } = await import('../public/js/hallway.js');

import { register } from 'node:module';

register('./vendor-resolve.js', import.meta.url);
