import {AlwatrContext} from '@alwatr/signal2';

import './main.js';

const worker = new Worker('./worker.js', {type: 'module'});
AlwatrContext.setupChannel(worker);
