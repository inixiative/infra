import { node } from '@inixiative/config/tsup';

export default node({
  entry: [
    'src/index.ts',
    'src/railway/index.ts',
    'src/render/index.ts',
    'src/fly/index.ts',
    'src/firecracker/index.ts',
    'src/lifecycle/index.ts',
  ],
  splitting: true,
  minify: true,
  treeshake: true,
  platform: 'node',
});
