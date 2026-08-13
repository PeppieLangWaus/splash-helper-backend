package com.splashhelper.itemicons;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.Reader;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import net.runelite.cache.IndexType;
import net.runelite.cache.ItemManager;
import net.runelite.cache.SpriteManager;
import net.runelite.cache.TextureManager;
import net.runelite.cache.definitions.ItemDefinition;
import net.runelite.cache.definitions.loaders.ModelLoader;
import net.runelite.cache.definitions.providers.ModelProvider;
import net.runelite.cache.fs.Archive;
import net.runelite.cache.fs.Index;
import net.runelite.cache.fs.Store;
import net.runelite.cache.item.ItemSpriteFactory;

/**
 * Renders an inventory icon PNG for every named item in an OSRS cache, headlessly, using the same
 * software rasterizer the RuneLite client uses for item icons (net.runelite.cache.item.ItemSpriteFactory).
 *
 * Usage: RenderItemIcons <cacheDir> <outDir> [quantitiesJson] [ids]
 *
 * cacheDir is a Jagex disk store (main_file_cache.dat2 + .idx files), e.g. an OpenRS2 disk.zip
 * extracted. Icons are rendered at quantity 10000 so stackable items (coins, runes, ...) show
 * their full-stack variant sprite (countObj/countCo) rather than a single unit — matching how
 * RuneProfile's own icons look, since that's the point of comparison here. quantitiesJson
 * optionally maps item IDs to override quantities for items whose stack variant isn't wanted.
 * ids is an optional comma-separated list of item IDs to render only a subset (for fast local
 * smoke-testing instead of a full ~4000-item render).
 *
 * Rendering runs on all cores. The shared managers are safe for concurrent createSprite calls
 * (texture pixel caching is synchronized upstream); the disk store is not, so model archive reads
 * are serialized behind a lock and memoized as decompressed bytes (items share models heavily),
 * with each task parsing its own ModelDefinition from those bytes since model instances get
 * mutated during rendering.
 */
public class RenderItemIcons
{
	private static final int DEFAULT_QUANTITY = 10000;
	// Matches the client's item icon rendering.
	private static final int BORDER = 1;
	private static final int SHADOW_COLOR = 3153952;

	public static void main(String[] args) throws Exception
	{
		if (args.length < 2)
		{
			System.err.println("Usage: RenderItemIcons <cacheDir> <outDir> [quantitiesJson] [ids]");
			System.exit(2);
		}

		File cacheDir = new File(args[0]);
		File outDir = new File(args[1]);
		if (!outDir.exists() && !outDir.mkdirs())
		{
			throw new IOException("Failed to create output directory: " + outDir);
		}

		Map<Integer, Integer> quantities = new HashMap<>();
		if (args.length >= 3 && !args[2].isEmpty())
		{
			try (Reader reader = new FileReader(args[2]))
			{
				Type type = new TypeToken<Map<Integer, Integer>>()
				{
				}.getType();
				quantities = new Gson().fromJson(reader, type);
			}
			System.out.println("Loaded " + quantities.size() + " quantity overrides");
		}

		Set<Integer> onlyIds = new HashSet<>();
		if (args.length >= 4 && !args[3].isEmpty())
		{
			for (String id : args[3].split(","))
			{
				onlyIds.add(Integer.parseInt(id.trim()));
			}
		}

		long start = System.currentTimeMillis();

		try (Store store = new Store(cacheDir))
		{
			store.load();

			ItemManager itemManager = new ItemManager(store);
			itemManager.load();
			itemManager.link();

			// The disk store is not thread safe; model archive reads go through this lock and are
			// memoized so shared models decompress only once.
			Object storeLock = new Object();
			ConcurrentHashMap<Integer, byte[]> modelData = new ConcurrentHashMap<>();
			ModelProvider modelProvider = modelId ->
			{
				byte[] data = modelData.computeIfAbsent(modelId, id ->
				{
					synchronized (storeLock)
					{
						try
						{
							Index models = store.getIndex(IndexType.MODELS);
							Archive archive = models.getArchive(id);
							return archive.decompress(store.getStorage().loadArchive(archive));
						}
						catch (IOException ex)
						{
							throw new RuntimeException(ex);
						}
					}
				});
				return new ModelLoader().load(modelId, data);
			};

			SpriteManager spriteManager = new SpriteManager(store);
			spriteManager.load();

			TextureManager textureManager = new TextureManager(store);
			textureManager.load();

			// Touch the ImageIO plugin registry once before going parallel.
			ImageIO.write(new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB), "png", new ByteArrayOutputStream());

			List<ItemDefinition> named = new ArrayList<>();
			for (ItemDefinition itemDef : itemManager.getItems())
			{
				if (itemDef.name != null && !itemDef.name.equalsIgnoreCase("null")
					&& (onlyIds.isEmpty() || onlyIds.contains(itemDef.id)))
				{
					named.add(itemDef);
				}
			}

			int threads = Runtime.getRuntime().availableProcessors();
			System.out.println("Rendering " + named.size() + " items on " + threads + " threads");

			AtomicInteger rendered = new AtomicInteger();
			ConcurrentLinkedQueue<Integer> failed = new ConcurrentLinkedQueue<>();

			ExecutorService pool = Executors.newFixedThreadPool(threads);
			Map<Integer, Integer> finalQuantities = quantities;
			for (ItemDefinition itemDef : named)
			{
				pool.submit(() ->
				{
					try
					{
						int quantity = finalQuantities.getOrDefault(itemDef.id, DEFAULT_QUANTITY);
						BufferedImage sprite = ItemSpriteFactory.createSprite(
							itemManager, modelProvider, spriteManager, textureManager,
							itemDef.id, quantity, BORDER, SHADOW_COLOR, false);
						if (sprite == null)
						{
							failed.add(itemDef.id);
							return;
						}

						ImageIO.write(sprite, "png", new File(outDir, itemDef.id + ".png"));
						int count = rendered.incrementAndGet();
						if (count % 2000 == 0)
						{
							System.out.println("  rendered " + count);
						}
					}
					catch (Exception ex)
					{
						failed.add(itemDef.id);
					}
				});
			}

			pool.shutdown();
			if (!pool.awaitTermination(60, TimeUnit.MINUTES))
			{
				throw new IOException("Render pool timed out");
			}

			long seconds = (System.currentTimeMillis() - start) / 1000;
			System.out.println("Rendered " + rendered.get() + " item icons to " + outDir + " in " + seconds + "s");
			if (!failed.isEmpty())
			{
				System.out.println("Failed to render " + failed.size() + " items: " + failed);
			}
			if (rendered.get() == 0)
			{
				System.err.println("No icons rendered - is the cache directory valid?");
				System.exit(1);
			}
		}
	}
}
