const WebSocket = require( "ws" );

const MAX_PEERS = 512;
const MAX_LOBBIES = 256;
const PORT = 9080;
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234679";

const NO_LOBBY_TIMEOUT = 1000;
const PING_INTERVAL = 10000;

function randomInt( low, high )
{
	return Math.floor( Math.random() * ( high - low + 1 ) + low );
}

function randomSecret()
{
	let out = "";
	for( let i = 0; i < 5; i++ )
	{
		out += ALNUM[ randomInt( 0, ALNUM.length - 1 ) ];
	}
	return out;
}

const wss = new WebSocket.Server( { port: PORT } );

class ProtoError extends Error
{
	constructor( code, message )
	{
		super( message );
		this.code = code;
	}
}

var peerId = 0;

class Peer
{
	constructor( ws )
	{
		this.id = peerId++;
		this.ws = ws;
		this.hosting = false;
		this.game = null;

		this.timeout = setTimeout( () =>
		{
			if( !this.game )
				ws.close( 4000, "NO_LOBBY" );
		}, NO_LOBBY_TIMEOUT );
	}

	joinGame( game )
	{
		clearTimeout( this.timeout );
		this.hosting = false;
		this.game = game;
	}

	hostGame( game )
	{
		clearTimeout( this.timeout );
		this.hosting = true;
		this.game = game;
	}

	send( message )
	{
		this.ws.send( message );
	}

	disconnect()
	{
		this.ws.close( 1000, "BYE" );
	}
}

class Game
{
	constructor( name )
	{
		this.name = randomSecret();
		this.host = null;
		this.peer = null;
		this.closeTimer = -1;
	}

	join( peer )
	{
		if( this.peer )
			throw new ProtoError( 4001, "GAME_FULL" );

		if( peer.game )
			throw new ProtoError( 4002, "ALREADY_IN_LOBBY" );

		peer.joinGame( this );
		this.peer = peer;

		console.log( `Peer ${peer.id} joining game ${this.name}` );

		peer.send( `GAME\n${this.name}` );
		peer.send( "PEER\n" );

		this.host.send( "PEER\n" );
	}

	joinHost( peer )
	{
		if( peer.game )
			throw new ProtoError( 4002, "ALREADY_IN_LOBBY" );

		peer.hostGame( this );
		this.host = peer;

		console.log( `Peer ${peer.id} hosts game ${this.name}` );

		peer.ws.send( `GAME\n${this.name}` );
	}

	close()
	{
		if( this.host ) this.host.disconnect();
		if( this.peer ) this.peer.disconnect();
	}
}

const games = new Map();
let peersCount = 0;

function joinGame( peer, gameName )
{
	const game = games.get( gameName );
	if( !game ) throw new ProtoError( 4010, "LOBBY_DOES_NOT_EXISTS" );

	game.join( peer );
}

function hostGame( peer )
{
	if( games.size >= MAX_LOBBIES )
		throw new ProtoError( 4020, "TOO_MANY_LOBBIES" );

	const game = new Game();
	games.set( game.name, game );

	game.joinHost( peer );
}

function parseMsg( peer, msg )
{
	if( msg.indexOf( "\n" ) < 0 ) throw new ProtoError( 4000, "INVALID_FORMAT" );

	const [ cmd, ...data ] = msg.split( "\n" )

	if( cmd == "HOST" )
	{
		hostGame( peer );
		return;
	}

	if( cmd == "JOIN" )
	{
		var game = data[0].toUpperCase().replace(/[0158]/,m=>({"0":"O","1":"I","5":"S","8":"B"}[m]))
		joinGame( peer, game );
		return;
	}

	if( !peer.game ) throw new ProtoError( 4003, "NEED_LOBBY" );
	const dest = peer.hosting ? peer.game.peer : peer.game.host;

	if( [ "OFFER", "ANSWER", "CANDIDATE" ].includes( cmd ) )
	{
		dest.send( cmd + "\n" + data.join("\n") );
		return;
	}

	throw new ProtoError( 4004, "INVALID_CMD" );
}

wss.on( "connection", ( ws ) =>
{
	if( peersCount >= MAX_PEERS )
	{
		ws.close( 4021, "TOO_MANY_PEERS" );
		return;
	}

	peersCount++;

	const peer = new Peer( ws );
	console.log( `Peer ${peer.id} connected` );

	ws.on( "message", ( message ) =>
	{
		if( typeof message !== "string" )
		{
			ws.close( 1003, "INVALID_TRANSFER_MODE" );
			return;
		}

		try
		{
			parseMsg( peer, message );
		} catch( e )
		{
			const code = e.code || 1005;
			console.log( `Error parsing message:\n` + message );
			ws.close( code, e.message );
		}
	} );

	ws.on( "close", ( code, reason ) =>
	{
		peersCount--;
		console.log( `Connection with peer ${peer.id} closed` );

		if( peer.game )
		{
			peer.game.close();
			games.delete( peer.game.name );
			console.log( `Deleting lobby ${peer.game.name}` );
			console.log( `Open lobbies: ${games.size}` );
			peer.game = null;
		}

		if( peer.timeout >= 0 )
			clearTimeout( peer.timeout );
	} );

	ws.on( "error", ( error ) =>
	{
		console.error( error );
	} );
} );

setInterval( () =>
{
	wss.clients.forEach( ( ws ) =>
	{
		ws.ping();
	} );
}, PING_INTERVAL );
