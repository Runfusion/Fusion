const fs = require('fs');
let content = fs.readFileSync('packages/engine/src/executor.test.ts', 'utf8');

// Fix the trailing comma issue by removing the comma after the template literal
content = content.replace(
  /at '\$\{conflictingPath\}'',\n {8}\);/g,
  "at '${conflictingPath}'" + "\n" + "        );"
);

fs.writeFileSync('packages/engine/src/executor.test.ts', content);
console.log('Fixed');
